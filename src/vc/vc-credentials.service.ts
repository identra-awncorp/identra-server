import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, VcCredentialStatus } from '@prisma/client';

import { apiError, unavailable } from '../common/http-errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { StatusRevokedError, type StatusListService } from '@identra/sdk-server';
import { issuerKind } from './hosted-issuers';
import { createPrismaStatusListStorage } from './status-storage';
import { STATUS_LIST_SERVICE } from './vc.providers';

const STATUS_CHANGE_ATTEMPTS = 3;
const LOCK_TIMEOUT_MS = 2000;
const TX_MAX_WAIT_MS = 2000;
const TX_TIMEOUT_MS = 8000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam: runs inside the status-change transaction, after the locks are taken. */
export const STATUS_CHANGE_HOOKS = Symbol('STATUS_CHANGE_HOOKS');
export interface StatusChangeHooks {
  insideStatusChange?(status: VcCredentialStatus): Promise<void>;
}

/** Lock timeout (55P03), pool or transaction-start timeouts: worth a retry, then 503. */
function isContention(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (['P2024', 'P2028', 'P2034'].includes(error.code)) return true;

  return error.code === 'P2010' && (error.meta as { code?: unknown } | undefined)?.code === '55P03';
}

interface StatusRecord {
  id: string;
  status: VcCredentialStatus;
  statusListNumber: number;
  statusIndex: number;
  statusChangedAt: Date;
}

const view = (row: StatusRecord) => ({ id: row.id, status: row.status, updatedAt: row.statusChangedAt.toISOString() });

/** What the issuer remembers about the credentials it issued (no claims, ADR-0014 §4). */
@Injectable()
export class VcCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STATUS_LIST_SERVICE) private readonly statusLists: StatusListService,
    @Optional() @Inject(STATUS_CHANGE_HOOKS) private readonly hooks?: StatusChangeHooks
  ) {}

  /**
   * Reserves a status-list entry and records the credential; the issuance of the next phase puts
   * `status` into the credential it signs. An entry reserved for a row that then fails to insert
   * stays reserved and unused (value 0), which is harmless.
   */
  async register(input: { issuerName: string; vct: string; subjectRef: string; cnfThumbprint: string }) {
    const { uri, n, idx } = await this.statusLists.allocate(input.issuerName);
    const row = await this.prisma.vcIssuedCredential.create({
      data: { id: randomBytes(16).toString('base64url'), ...input, statusListNumber: n, statusIndex: idx }
    });

    return { id: row.id, status: { uri, idx } };
  }

  /**
   * Records a credential the OpenID4VCI issuer has just built (its onIssued callback), with the
   * status entry the issuer allocated. Idempotent on `offerId`: a repeated call returns the row
   * of the first one instead of creating a second.
   */
  async recordIssued(input: {
    issuerName: string;
    vct: string;
    offerId: string;
    subjectRef: string;
    statusUri: string;
    statusIdx: number;
    cnfThumbprint: string;
    issuedAt: Date;
  }): Promise<{ credentialId: string }> {
    const prefix = this.statusLists.uri(input.issuerName, 1).replace(/1$/, '');

    if (!input.statusUri.startsWith(prefix)) throw new Error('the status entry belongs to another issuer');

    const data = {
      id: randomBytes(16).toString('base64url'),
      issuerName: input.issuerName,
      vct: input.vct,
      offerId: input.offerId,
      subjectRef: input.subjectRef,
      statusListNumber: Number(input.statusUri.slice(prefix.length)),
      statusIndex: input.statusIdx,
      cnfThumbprint: input.cnfThumbprint,
      issuedAt: input.issuedAt,
      statusChangedAt: input.issuedAt
    };

    try {
      return { credentialId: (await this.prisma.vcIssuedCredential.create({ data })).id };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;

      const existing = await this.prisma.vcIssuedCredential.findUniqueOrThrow({ where: { offerId: input.offerId } });

      return { credentialId: existing.id };
    }
  }

  /**
   * Changes a credential's status: the row and the list entry together, in ONE transaction.
   * The credential row is locked first (SELECT … FOR UPDATE), then the list row, so changes of
   * one credential are serialised and writers of one list queue instead of racing. Inside the
   * locks the decision uses the row AND the list: the list entry is always set (a request for
   * the status the row already has still repairs a list that disagrees), revoked stays final on
   * either side. Lock or pool timeouts are retried briefly, then answered 503 (Retry-After: 1).
   */
  async changeStatus(issuerName: string, id: string, status: VcCredentialStatus) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.changeStatusOnce(issuerName, id, status);
      } catch (error) {
        if (!isContention(error)) throw error;
        if (attempt >= STATUS_CHANGE_ATTEMPTS) throw unavailable('The credential is being changed by another request; try again.');

        await sleep(25 * attempt + Math.floor(Math.random() * 50));
      }
    }
  }

  private async changeStatusOnce(issuerName: string, id: string, status: VcCredentialStatus) {
    // Diplomas are recorded in VcIssuedCredential, product events in ProductEvent: one code path.
    const kind = issuerKind(issuerName);

    if (kind === null) throw apiError(404, 'NOT_FOUND', 'No such credential for this issuer.');

    const table = kind === 'product' ? '"ProductEvent"' : '"VcIssuedCredential"';
    let revokedInList = false;

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

        const [row] = await tx.$queryRawUnsafe<StatusRecord[]>(
          `SELECT "id", "status"::text AS "status", "statusListNumber", "statusIndex", "statusChangedAt"
           FROM ${table} WHERE "id" = $1 AND "issuerName" = $2 FOR UPDATE`,
          id,
          issuerName
        );

        if (!row) throw apiError(404, 'NOT_FOUND', 'No such credential for this issuer.');

        await tx.$queryRaw`
          SELECT 1 FROM "VcStatusList"
          WHERE "issuerName" = ${issuerName} AND "listNumber" = ${row.statusListNumber} FOR UPDATE`;

        if (row.status === 'revoked' && status !== 'revoked') {
          throw apiError(409, 'CONFLICT', 'The credential is revoked; revocation is final.');
        }

        await this.hooks?.insideStatusChange?.(status);

        const write = async (next: VcCredentialStatus): Promise<StatusRecord> => {
          if (row.status === next) return row;

          const changedAt = new Date();

          await tx.$executeRawUnsafe(
            `UPDATE ${table} SET "status" = $1::"VcCredentialStatus", "statusChangedAt" = $2 WHERE "id" = $3`,
            next,
            changedAt,
            id
          );

          return { ...row, status: next, statusChangedAt: changedAt };
        };

        try {
          // The list update joins this transaction through a storage bound to it.
          await this.statusLists.setStatus(issuerName, row.statusListNumber, row.statusIndex, status, {
            storage: createPrismaStatusListStorage(tx)
          });
        } catch (error) {
          if (!(error instanceof StatusRevokedError)) throw error;

          // The list already says revoked (final): the row follows the list, the request fails.
          revokedInList = true;

          return write('revoked');
        }

        return write(status);
      },
      { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS }
    );

    if (revokedInList) throw apiError(409, 'CONFLICT', 'The credential is revoked; revocation is final.');

    return view(updated);
  }
}
