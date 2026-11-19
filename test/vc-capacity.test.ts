// H1: the anonymous protocol state has a bounded Redis cost (docs/vc-api.md §8): a global cap on
// live verification sessions and c_nonces, a global rate limit on session creation, and health
// that reports Redis memory pressure. Small caps here; the production defaults are tested in
// env-validation.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { RedisService } from '../src/infrastructure/redis/redis.service';
import { HealthService } from '../src/modules/health/health.service';
import { ISSUER_CLOCK } from '../src/vc/vc.providers';
import { VERIFIER_CLOCK } from '../src/vc/verifiers';
import { adjustableClock } from './e2e-world';
import { createTestApp, testKeysDir } from './helpers';

const CAP = 50;
const NONCE_CAP = 20;
// Only ever moved forward here: moving back would leave live entries scored in the future.
const verifierClock = adjustableClock();
const issuerClock = adjustableClock();
let app: NestExpressApplication;

before(async () => {
  app = await createTestApp(
    { IDENTRA_KEYS_DIR: testKeysDir(), VERIFICATION_MAX_LIVE_SESSIONS: String(CAP), ISSUANCE_MAX_LIVE_NONCES: String(NONCE_CAP) },
    { override: (builder) => builder.overrideProvider(VERIFIER_CLOCK).useValue(verifierClock).overrideProvider(ISSUER_CLOCK).useValue(issuerClock) }
  );
});

after(async () => {
  HealthService.memoryProbeEveryMs = 10_000;
  await app?.close();
});

const redis = () => app.get(RedisService).getClient();
const http = () => request(app.getHttpServer());
let ipSeq = 0;
// A fresh client address for every request: the per-client limit never interferes here.
const nextIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${(ipSeq++ & 255) || 1}`;
const createSession = () =>
  http().post('/v1/verification/sessions').set('X-Forwarded-For', nextIp()).send({ verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' });
const openSessions = async () => (await redis().keys('state:vp:*:open:*')).length;
const clearRateLimits = async () => {
  const keys = await redis().keys('throttle:*');

  if (keys.length > 0) await redis().del(...keys);
};

describe('global cap on live verification sessions', () => {
  it(`200 concurrent creations: exactly ${CAP} live, the rest 503 with Retry-After; the count returns to zero after expiry`, async () => {
    // Request objects of earlier files may still be in Redis (real TTL): count this burst's only.
    const openBefore = await openSessions();
    const results = await Promise.all(Array.from({ length: 200 }, () => createSession()));
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 503);

    assert.equal(created.length, CAP);
    assert.equal(refused.length, 200 - CAP);
    assert.equal((await openSessions()) - openBefore, CAP, 'never more than the cap hold a request object');
    assert.equal(await redis().zcard('state:live:vp-sessions'), CAP);

    for (const r of refused) {
      assert.equal(r.body.code, 'UNAVAILABLE');
      // Until the oldest live session ends (5 minutes).
      assert.ok(Number(r.headers['retry-after']) > 250 && Number(r.headers['retry-after']) <= 300, r.headers['retry-after']);
    }

    // L7: the id is the capability to read the result.
    assert.equal(created[0]!.headers['cache-control'], 'no-store');
    assert.equal(refused[0]!.headers['cache-control'], 'no-store');

    verifierClock.advance(301);
    const again = await createSession().expect(201);

    // Expired members were pruned: only the new session is counted.
    assert.ok(again.body.id);
    assert.equal(await redis().zcard('state:live:vp-sessions'), 1);
    assert.equal((await http().get(`/v1/verification/sessions/${created[0]!.body.id}`).expect(200)).body.status, 'expired');
  });

  it('a creation that fails gives its place back', async () => {
    const before = await redis().zcard('state:live:vp-sessions');

    await http().post('/v1/verification/sessions').set('X-Forwarded-For', nextIp()).send({ verifier: 'nha-tuyen-dung-mau', scenario: 'khong-co' }).expect(404);
    assert.equal(await redis().zcard('state:live:vp-sessions'), before);
  });
});

describe('global rate limit on session creation (300 per minute across all clients)', () => {
  it('the 301st creation in a minute is 429 from any address, with Retry-After and a fixed message', async () => {
    await clearRateLimits();
    // Far apart on the verifiers' clock, so the cap is not what refuses them.
    for (let i = 0; i < 300; i += 1) {
      if (i % CAP === 0) verifierClock.advance(301);

      assert.equal((await createSession()).status, 201, `creation ${i}`);
    }

    for (let i = 0; i < 2; i += 1) {
      const limited = await createSession().expect(429);

      assert.deepEqual(limited.body, { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests; try again later.' });
      assert.ok(Number(limited.headers['retry-after']) > 0);
      // The shared count is not exposed.
      assert.equal(limited.headers['x-ratelimit-limit-global'], undefined);
    }

    await clearRateLimits();
  });

  it('the per-client limit counts an IPv6 /64 as one client', async () => {
    await clearRateLimits();
    verifierClock.advance(301);

    for (let i = 0; i < 30; i += 1) {
      const res = await http()
        .post('/v1/verification/sessions')
        .set('X-Forwarded-For', `2001:db8:1:2:${i.toString(16)}::1`)
        .send({ verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' });

      assert.equal(res.status, 201);
    }

    await http().post('/v1/verification/sessions').set('X-Forwarded-For', '2001:db8:1:2:ffff::9').send({ verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' }).expect(429);
    // Another /64 is another client.
    await http().post('/v1/verification/sessions').set('X-Forwarded-For', '2001:db8:1:3::1').send({ verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' }).expect(201);
  });
});

describe('global cap on live c_nonces (the anonymous POST /issuers/:name/nonce)', () => {
  it(`${NONCE_CAP} live nonces, then 503 temporarily_unavailable with Retry-After until they expire`, async () => {
    const nonce = () => http().post('/issuers/truong-mau/nonce').set('X-Forwarded-For', nextIp());
    const results = await Promise.all(Array.from({ length: NONCE_CAP + 10 }, () => nonce()));

    assert.equal(results.filter((r) => r.status === 200).length, NONCE_CAP);
    for (const r of results.filter((r) => r.status !== 200)) {
      assert.deepEqual([r.status, r.body.error], [503, 'temporarily_unavailable']);
      assert.ok(Number(r.headers['retry-after']) > 0);
    }

    issuerClock.advance(301);
    await nonce().expect(200);
  });
});

describe('health under Redis memory pressure', () => {
  it('redis is degraded above 80 % of maxmemory and when writes are refused (OOM); writes answer 503, never 500', async (t) => {
    HealthService.memoryProbeEveryMs = 0;

    const [, original] = (await redis().config('GET', 'maxmemory')) as [string, string];
    const used = async () => Number(/used_memory:(\d+)/.exec(await redis().info('memory'))![1]);

    t.after(async () => {
      await redis().config('SET', 'maxmemory', original);
    });

    const health = async () => (await http().get('/v1/health').expect(200)).body;

    assert.equal((await health()).services.redis.status, 'up');

    await redis().config('SET', 'maxmemory', String(Math.floor((await used()) / 0.9)));
    assert.deepEqual([(await health()).services.redis.status, (await health()).status], ['degraded', 'degraded']);

    // Below what is used: every write is refused with OOM, reads and PING still work.
    await redis().config('SET', 'maxmemory', String(Math.floor((await used()) / 2)));
    assert.equal((await health()).services.redis.status, 'degraded');

    verifierClock.advance(301);
    const refused = await createSession();

    // Its rate limiter fails closed on the refused counter write.
    assert.deepEqual([refused.status, refused.body.code], [503, 'UNAVAILABLE']);
    assert.ok(Number(refused.headers['retry-after']) > 0);

    // The nonce route's limiter fails open; the cap's own write is refused (OOM) → 503, not 500.
    const nonce = await http().post('/issuers/truong-mau/nonce').set('X-Forwarded-For', nextIp());

    assert.deepEqual([nonce.status, nonce.body.error, nonce.headers['retry-after']], [503, 'temporarily_unavailable', '5']);

    await redis().config('SET', 'maxmemory', original);
    assert.equal((await health()).services.redis.status, 'up');
  });
});
