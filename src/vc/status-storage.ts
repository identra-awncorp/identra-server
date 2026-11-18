import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma } from '@prisma/client';

import { PrismaService } from '../infrastructure/prisma/prisma.service';
import type { StatusListStorage } from '../sdk.mjs';

/**
 * While a callback runs inside `statusListTransaction.run(tx, …)`, the storage below uses that
 * Prisma transaction. This is how a status change and the credential row commit together or
 * not at all (VcCredentialsService.changeStatus), although the SDK service makes its own calls.
 */
export const statusListTransaction = new AsyncLocalStorage<Prisma.TransactionClient>();

/**
 * StatusListStorage of @identra/sdk-server on Postgres. Each method is one atomic statement:
 * optimistic `UPDATE … WHERE version = $expected`, and `INSERT … ON CONFLICT DO NOTHING` on the
 * (issuer, list, idx) primary key so two concurrent allocations never get one index.
 */
export function createPrismaStatusListStorage(prisma: PrismaService): StatusListStorage {
  const db = () => statusListTransaction.getStore() ?? prisma;
  const list = (issuerName: string, listNumber: number) => ({ issuerName, listNumber });

  return {
    async load(issuer, n) {
      const row = await db().vcStatusList.findUnique({ where: { issuerName_listNumber: list(issuer, n) } });

      return row
        ? { bytes: new Uint8Array(row.bytes), version: row.version, lastIat: row.lastIat === null ? null : Number(row.lastIat) }
        : null;
    },
    async save(issuer, n, bytes, expectedVersion) {
      const data = Uint8Array.from(bytes);

      if (expectedVersion === null) {
        const created = await db().vcStatusList.createMany({
          data: [{ ...list(issuer, n), bytes: data, version: 1 }],
          skipDuplicates: true
        });

        return created.count === 1;
      }

      const updated = await db().vcStatusList.updateMany({
        where: { ...list(issuer, n), version: expectedVersion },
        data: { bytes: data, version: { increment: 1 } }
      });

      return updated.count === 1;
    },
    async recordIat(issuer, n, iat) {
      await db().$executeRaw`
        UPDATE "VcStatusList" SET "lastIat" = GREATEST(COALESCE("lastIat", 0), ${BigInt(iat)}), "updatedAt" = now()
        WHERE "issuerName" = ${issuer} AND "listNumber" = ${n}`;
    },
    async reserve(issuer, n, idx) {
      const inserted = await db().vcStatusIndex.createMany({ data: [{ ...list(issuer, n), idx }], skipDuplicates: true });

      return inserted.count === 1;
    },
    async isReserved(issuer, n, idx) {
      return (await db().vcStatusIndex.count({ where: { ...list(issuer, n), idx } })) === 1;
    }
  };
}
