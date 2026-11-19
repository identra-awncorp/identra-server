// H1: the anonymous protocol state has a bounded Redis cost (docs/vc-api.md §8): global caps on
// live verification sessions, c_nonces and offers, each with a per-client share, and health that
// reports Redis memory pressure. Small global caps here; the production defaults are tested in
// env-validation, the reviewer's floods at the defaults in vc-abuse.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MAX_RESPONSE_ATTEMPTS } from '@identra/sdk-server';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { HealthService } from '../src/modules/health/health.service';
import { NONCES_PER_CLIENT, OFFERS_PER_CLIENT } from '../src/vc/issuers';
import { ISSUER_CLOCK } from '../src/vc/vc.providers';
import { SESSION_RECORDS_PER_CLIENT, SESSIONS_PER_CLIENT } from '../src/vc/verification.controllers';
import { HostedVerifiers, VERIFIER_CLOCK, VERIFIERS } from '../src/vc/verifiers';
import { adjustableClock } from './e2e-world';
import { createTestApp, portalLogin, seedPortalAccounts, testKeysDir } from './helpers';

const CAP = 50;
const NONCE_CAP = 50;
const OFFER_CAP = 8;
// Only ever moved forward here: moving back would leave live entries scored in the future.
const verifierClock = adjustableClock();
const issuerClock = adjustableClock();
let app: NestExpressApplication;

before(async () => {
  app = await createTestApp(
    {
      IDENTRA_KEYS_DIR: testKeysDir(),
      VERIFICATION_MAX_LIVE_SESSIONS: String(CAP),
      ISSUANCE_MAX_LIVE_NONCES: String(NONCE_CAP),
      ISSUANCE_MAX_LIVE_OFFERS: String(OFFER_CAP)
    },
    { override: (builder) => builder.overrideProvider(VERIFIER_CLOCK).useValue(verifierClock).overrideProvider(ISSUER_CLOCK).useValue(issuerClock) }
  );
  await seedPortalAccounts(app.get(PrismaService));
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

  it('a creation that fails gives its place back: refused by the verifier, or throwing (M4)', async (t) => {
    const verifiers = app.get<HostedVerifiers>(VERIFIERS);
    const real = verifiers.available.bind(verifiers);
    const before = await redis().zcard('state:live:vp-sessions');

    t.after(() => void (verifiers.available = real));

    // An unknown scenario is refused before any place is reserved.
    await http().post('/v1/verification/sessions').set('X-Forwarded-For', nextIp()).send({ verifier: 'nha-tuyen-dung-mau', scenario: 'khong-co' }).expect(404);
    assert.equal(await redis().zcard('state:live:vp-sessions'), before);

    for (const createSession of [
      async () => ({ ok: false, reason: 'unknown_scenario' }),
      async () => {
        throw new Error('the signer failed');
      }
    ]) {
      verifiers.available = async () => ({ createSession }) as never;
      const res = await createSessionFrom(nextIp());

      assert.ok(res.status === 404 || res.status === 500, String(res.status));
      assert.equal(await redis().zcard('state:live:vp-sessions'), before, 'the place was given back');
    }
  });
});

const createSessionFrom = (ip: string) =>
  http().post('/v1/verification/sessions').set('X-Forwarded-For', ip).send({ verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' });

describe('per-client share of live verification sessions', () => {
  it(`one client holds at most ${SESSIONS_PER_CLIENT}; then 429 RATE_LIMITED with Retry-After, other clients unaffected`, async () => {
    await clearRateLimits();
    verifierClock.advance(301);

    for (let i = 0; i < SESSIONS_PER_CLIENT; i += 1) await createSessionFrom('203.0.113.9').expect(201);

    const refused = await createSessionFrom('203.0.113.9').expect(429);

    assert.equal(refused.body.code, 'RATE_LIMITED');
    assert.ok(Number(refused.headers['retry-after']) > 250, refused.headers['retry-after']);
    await createSessionFrom('203.0.113.10').expect(201);
    // An IPv6 client is its /56: another /64 inside it is the same client.
    for (let i = 0; i < SESSIONS_PER_CLIENT; i += 1) await createSessionFrom(`2001:db8:5:${(0x100 + i).toString(16)}::1`).expect(201);
    await createSessionFrom('2001:db8:5:1ff::7').expect(429);
    await createSessionFrom('2001:db8:5:200::1').expect(201);
  });

  it('there is no global per-minute budget any more: 300 creations in a minute from many clients all succeed', async () => {
    await clearRateLimits();

    for (let i = 0; i < 300; i += 1) {
      // The global cap is not what is tested here: move past each batch's 5 minutes.
      if (i % CAP === 0) verifierClock.advance(301);

      assert.equal((await createSession()).status, 201, `creation ${i}`);
    }
  });

  it('the per-client rate limit counts an IPv6 /64 as one client', async () => {
    await clearRateLimits();

    for (let i = 0; i < 30; i += 1) {
      // The live share (per /56) is freed every 10, so only the rate limit (per /64) can refuse.
      if (i % SESSIONS_PER_CLIENT === 0) verifierClock.advance(301);

      const res = await createSessionFrom(`2001:db8:1:2:${i.toString(16)}::1`);

      assert.equal(res.status, 201);
    }

    verifierClock.advance(301);
    const limited = await createSessionFrom('2001:db8:1:2:ffff::9').expect(429);

    assert.equal(limited.body.message, 'Too many requests; try again later.');
    // Another /64 is another client of the rate limit.
    await createSessionFrom('2001:db8:1:3::1').expect(201);
  });
});

describe('a final verification session gives its live place back (classroom NAT)', () => {
  const requestIdOf = (qr: string) => new URL(new URL(qr).searchParams.get('request_uri')!).pathname.split('/').pop()!;
  // MAX_RESPONSE_ATTEMPTS refused responses (from wallets' own addresses) make a session final: failed.
  const finish = async (qr: string) => {
    for (let i = 0; i < MAX_RESPONSE_ATTEMPTS; i += 1) {
      await http().post(`/oid4vp/response/${requestIdOf(qr)}`).set('X-Forwarded-For', nextIp()).set('Content-Type', 'text/plain').send('x').expect(400);
    }
  };

  it(`at once, not after 5 minutes; the ${SESSION_RECORDS_PER_CLIENT} sessions of 30 minutes still bound what one client creates`, async () => {
    // The 30-minute records of the earlier tests end; only this client's count from here.
    verifierClock.advance(1801);
    await clearRateLimits();

    const ip = '203.0.113.70';
    const open: Array<{ id: string; qr: string }> = [];

    for (let i = 0; i < SESSIONS_PER_CLIENT; i += 1) open.push((await createSessionFrom(ip).expect(201)).body);
    await createSessionFrom(ip).expect(429);

    const done = open.shift()!;

    await finish(done.qr);
    assert.equal((await http().get(`/v1/verification/sessions/${done.id}`).expect(200)).body.status, 'failed');
    assert.equal(await redis().exists(`state:vp-place:${done.id}`), 0, 'its place mapping is taken');
    open.push((await createSessionFrom(ip).expect(201)).body);

    // Freeing live places does not buy more: creations stop at the 30-minute share.
    for (let created = SESSIONS_PER_CLIENT + 1; created < SESSION_RECORDS_PER_CLIENT; created += 1) {
      if (created % 25 === 0) await clearRateLimits(); // the 30/min creation limit is not what is tested
      await finish(open.shift()!.qr);
      open.push((await createSessionFrom(ip).expect(201)).body);
    }

    await finish(open.shift()!.qr);
    await clearRateLimits();
    const refused = await createSessionFrom(ip).expect(429);

    assert.equal(refused.body.code, 'RATE_LIMITED');
    // Until the oldest of its 30-minute records ends, not a 5-minute live place.
    assert.ok(Number(refused.headers['retry-after']) > 1500, refused.headers['retry-after']);
    await createSessionFrom('203.0.113.71').expect(201);
    verifierClock.advance(1801);
  });
});

describe('caps on live c_nonces (the anonymous POST /issuers/:name/nonce)', () => {
  const nonceFrom = (ip: string) => http().post('/issuers/truong-mau/nonce').set('X-Forwarded-For', ip);
  const storedNonces = async () => (await redis().keys('state:vci:*:nonce:*')).length;

  it(`one client holds at most ${NONCES_PER_CLIENT} (then 429); all clients ${NONCE_CAP} (then 503); a refused nonce is not stored`, async () => {
    issuerClock.advance(301);
    const stored = await storedNonces();
    const one = await Promise.all(Array.from({ length: NONCES_PER_CLIENT + 5 }, () => nonceFrom('203.0.113.20')));

    assert.equal(one.filter((r) => r.status === 200).length, NONCES_PER_CLIENT);
    for (const r of one.filter((r) => r.status !== 200)) {
      assert.deepEqual([r.status, r.body.error], [429, 'temporarily_unavailable']);
      assert.ok(Number(r.headers['retry-after']) > 0);
    }
    assert.equal((await storedNonces()) - stored, NONCES_PER_CLIENT, 'refused nonces were removed again');

    const many = await Promise.all(Array.from({ length: NONCE_CAP }, () => nonceFrom(nextIp())));

    assert.equal(many.filter((r) => r.status === 200).length, NONCE_CAP - NONCES_PER_CLIENT);
    for (const r of many.filter((r) => r.status !== 200)) {
      assert.deepEqual([r.status, r.body.error], [503, 'temporarily_unavailable']);
      assert.ok(Number(r.headers['retry-after']) > 0);
    }
    assert.equal(await redis().zcard('state:live:vci-nonces:truong-mau'), NONCE_CAP);

    issuerClock.advance(301);
    await nonceFrom(nextIp()).expect(200);
  });
});

describe('caps on live offers (M17: the school portal)', () => {
  const statusRecords = async () => (await redis().keys('state:vci:*:status:*')).length;
  const offerFrom = (token: string, ip: string) => http().post('/v1/demo/school/offers').auth(token, { type: 'bearer' }).set('X-Forwarded-For', ip);

  it(`a client holds ${OFFERS_PER_CLIENT} live offers (then 429), everybody ${OFFER_CAP} (then 503); refused offers leave nothing; a cancelled one frees its place`, async () => {
    issuerClock.advance(601);
    await clearRateLimits();
    const token = await portalLogin(app, 'sv001');
    const records = await statusRecords();
    const created: string[] = [];

    for (let i = 0; i < OFFERS_PER_CLIENT; i += 1) created.push((await offerFrom(token, '203.0.113.30').expect(201)).body.offerId);

    const own = await offerFrom(token, '203.0.113.30').expect(429);

    assert.equal(own.body.code, 'RATE_LIMITED');
    assert.ok(Number(own.headers['retry-after']) > 500, own.headers['retry-after']);

    for (let i = OFFERS_PER_CLIENT; i < OFFER_CAP; i += 1) created.push((await offerFrom(token, `203.0.113.${31 + i}`).expect(201)).body.offerId);

    const full = await offerFrom(token, '203.0.113.99').expect(503);

    assert.equal(full.body.code, 'UNAVAILABLE');
    assert.ok(Number(full.headers['retry-after']) > 500, full.headers['retry-after']);
    assert.equal((await statusRecords()) - records, OFFER_CAP, 'the refused offers left no status record');

    await http().delete(`/v1/demo/school/offers/${created[0]}`).auth(token, { type: 'bearer' }).expect(200);
    await offerFrom(token, '203.0.113.30').expect(201);
    await offerFrom(token, '203.0.113.99').expect(503);
    assert.equal(await redis().zcard('state:live:vci-offers:truong-mau'), OFFER_CAP);
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
