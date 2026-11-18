import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, VcCredentialStatus, VcIssuedCredential } from '@prisma/client';

import { apiError, unavailable } from '../common/http-errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { StatusRevokedError, type StatusListService } from '@identra/sdk-server';
import { statusListTransaction } from './status-storage';
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

const view = (row: VcIssuedCredential) => ({ id: row.id, status: row.status, updatedAt: row.statusChangedAt.toISOString() });

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
    const status = await this.statusLists.allocate(input.issuerName);
    const listNumber = Number(status.uri.slice(status.uri.lastIndexOf('/') + 1));
    const row = await this.prisma.vcIssuedCredential.create({
      data: {
        id: randomBytes(16).toString('base64url'),
        ...input,
        statusListNumber: listNumber,
        statusIndex: status.idx
      }
    });

    return { id: row.id, status };
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
    let revokedInList = false;

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

        const [row] = await tx.$queryRaw<VcIssuedCredential[]>`
          SELECT * FROM "VcIssuedCredential" WHERE "id" = ${id} AND "issuerName" = ${issuerName} FOR UPDATE`;

        if (!row) throw apiError(404, 'NOT_FOUND', 'No such credential for this issuer.');

        await tx.$queryRaw`
          SELECT 1 FROM "VcStatusList"
          WHERE "issuerName" = ${issuerName} AND "listNumber" = ${row.statusListNumber} FOR UPDATE`;

        if (row.status === 'revoked' && status !== 'revoked') {
          throw apiError(409, 'CONFLICT', 'The credential is revoked; revocation is final.');
        }

        await this.hooks?.insideStatusChange?.(status);

        try {
          await statusListTransaction.run(tx, () =>
            this.statusLists.setStatus(issuerName, row.statusListNumber, row.statusIndex, status)
          );
        } catch (error) {
          if (!(error instanceof StatusRevokedError)) throw error;

          // The list already says revoked (final): the row follows the list, the request fails.
          revokedInList = true;

          return row.status === 'revoked'
            ? row
            : tx.vcIssuedCredential.update({ where: { id }, data: { status: 'revoked', statusChangedAt: new Date() } });
        }

        return row.status === status
          ? row
          : tx.vcIssuedCredential.update({ where: { id }, data: { status, statusChangedAt: new Date() } });
      },
      { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS }
    );

    if (revokedInList) throw apiError(409, 'CONFLICT', 'The credential is revoked; revocation is final.');

    return view(updated);
  }
}
