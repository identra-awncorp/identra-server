// H1 regression: the reviewer's flood of anonymous POST /v1/verification/sessions from rotating
// addresses, against a Redis with a small maxmemory and `noeviction` (production: 128 MB). Before
// the cap the flood filled Redis and every sign-in, offer and issuance failed while health said ok.
// The cap is scaled to this Redis (600 × ~7.4 KB ≈ 4.4 MB of 12 MB).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';

import { RedisService } from '../src/infrastructure/redis/redis.service';
import { HealthService } from '../src/modules/health/health.service';
import { call, issueDiplomaTo, keysDir, newWallet, PORT } from './e2e-world';
import { createTestApp, registerUser, seedPortalAccounts } from './helpers';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const CAP = 600;
const MAXMEMORY = 12 * 1024 * 1024;
let app: NestExpressApplication;
let original = '';

const redis = () => app.get(RedisService).getClient();
const used = async () => Number(/used_memory:(\d+)/.exec(await redis().info('memory'))![1]);

before(async () => {
  app = await createTestApp({
    IDENTRA_KEYS_DIR: keysDir,
    VERIFICATION_MAX_LIVE_SESSIONS: String(CAP)
  });
  await app.listen(PORT, '127.0.0.1');
  await seedPortalAccounts(app.get(PrismaService));
  // A clean, small Redis for this file (test files run one at a time).
  await redis().flushdb();
  original = ((await redis().config('GET', 'maxmemory')) as string[])[1]!;
  await redis().config('SET', 'maxmemory', String(MAXMEMORY));
  HealthService.memoryProbeEveryMs = 0;
});

after(async () => {
  HealthService.memoryProbeEveryMs = 10_000;
  if (app) {
    // Leave nothing of the flood behind for the next file, and the limit as it was.
    await redis().flushdb();
    if (original) await redis().config('SET', 'maxmemory', original);
    await app.close();
  }
});

describe('a flood of verification sessions from rotating addresses (H1)', () => {
  it('stops at the cap; Redis stays far from maxmemory; sign-in and issuance keep working', async () => {
    let n = 0;
    const statuses: Record<number, number> = {};

    for (let round = 0; round < 40; round += 1) {
      const batch = await Promise.all(
        Array.from({ length: 50 }, () =>
          call('POST', '/v1/verification/sessions', {
            body: { verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' },
            ip: `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n++ & 255}`
          })
        )
      );

      for (const r of batch) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }

    console.log(`flood: 2000 creations → ${JSON.stringify(statuses)}; Redis used ${(await used()) >> 10} KiB of ${MAXMEMORY >> 10} KiB`);
    assert.deepEqual(statuses, { 201: CAP, 503: 2000 - CAP });
    assert.ok((await used()) < MAXMEMORY * 0.8, 'Redis stays below the health threshold');

    // Health tells the truth (and here: all is well).
    const health = (await call('GET', '/v1/health')).body;
    assert.deepEqual([health.status, health.services.redis.status], ['ok', 'up']);

    // Sign-in: the app's own registration and the school portal.
    assert.ok((await registerUser(app)).accessToken);

    // Issuance end to end (portal sign-in, offer, token, nonce, credential).
    const holder = newWallet();
    assert.ok(await issueDiplomaTo(holder.wallet, 'sv002'));
  });
});
