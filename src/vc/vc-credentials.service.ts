import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { VcCredentialStatus, VcIssuedCredential } from '@prisma/client';

import { apiError } from '../common/http-errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { StatusRevokedError, type StatusListService } from '../sdk.mjs';
import { statusListTransaction } from './status-storage';
import { STATUS_LIST_SERVICE } from './vc.providers';

const view = (row: VcIssuedCredential) => ({ id: row.id, status: row.status, updatedAt: row.statusChangedAt.toISOString() });

/** What the issuer remembers about the credentials it issued (no claims, ADR-0014 §4). */
@Injectable()
export class VcCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STATUS_LIST_SERVICE) private readonly statusLists: StatusListService
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
   * Changes the status list entry and the row in ONE database transaction: the list first (the
   * SDK service enforces that revoked is final), then the row. If either step fails, both roll
   * back, so the published list and the row never disagree. A token signed meanwhile cannot
   * include the change: it is not visible outside the transaction until commit.
   */
  async changeStatus(issuerName: string, id: string, status: VcCredentialStatus) {
    const row = await this.prisma.vcIssuedCredential.findFirst({ where: { id, issuerName } });

    if (!row) throw apiError(404, 'NOT_FOUND', 'No such credential for this issuer.');
    if (row.status === status) return view(row);
    if (row.status === 'revoked') throw apiError(409, 'CONFLICT', 'The credential is revoked; revocation is final.');

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await statusListTransaction.run(tx, () =>
          this.statusLists.setStatus(issuerName, row.statusListNumber, row.statusIndex, status)
        );

        return tx.vcIssuedCredential.update({ where: { id }, data: { status, statusChangedAt: new Date() } });
      });

      return view(updated);
    } catch (error) {
      if (error instanceof StatusRevokedError) {
        throw apiError(409, 'CONFLICT', 'The credential is revoked; revocation is final.');
      }

      throw error;
    }
  }
}
