// The final review's denial-of-service sequences (B-1, B-2, B-3; reviewer's dos.mjs), at the
// production caps, over real HTTP, plus the shared public accounts (B-4). Before the fixes:
// 2006 nonces from 34 addresses filled the 2000 global nonces and every wallet failed; 504 offers
// from one sign-in filled the 500 offers; 300 INVALID session requests from 10 addresses spent the
// 300/min global session budget. Now each client has a share inside every cap.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';

import { NETWORK_SHARES } from '../src/common/live-cap';
import { RATE_LIMITS } from '../src/common/rate-limit';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { NONCES_PER_CLIENT, OFFERS_PER_CLIENT } from '../src/vc/issuers';
import { SESSIONS_PER_CLIENT } from '../src/vc/verification.controllers';
import { call, keysDir, LOCAL, login, newOffer, newWallet, offerState, PORT } from './e2e-world';
import { createTestApp, seedPortalAccounts, TEST_PORTAL_PASSWORD } from './helpers';

let app: NestExpressApplication;

before(async () => {
  // The production defaults: 2000 sessions, 2000 nonces, 500 offers.
  app = await createTestApp({ IDENTRA_KEYS_DIR: keysDir });
  await app.listen(PORT, '127.0.0.1');
  await seedPortalAccounts(app.get(PrismaService));
});

after(async () => {
  await app?.close();
});

const redis = () => app.get(RedisService).getClient();
const ipN = (a: number, b: number) => `198.18.${a}.${b}`;

async function pool<T>(tasks: Array<() => Promise<T>>, concurrency = 40): Promise<T[]> {
  const out: T[] = [];
  let next = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < tasks.length) {
        const k = next++;

        out[k] = await tasks[k]!();
      }
    })
  );

  return out;
}

const tally = (statuses: number[]) => statuses.reduce<Record<number, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
const flood = async (clients: number, perClient: number, request: (ip: string) => Promise<number>, range: number) => {
  const tasks: Array<() => Promise<number>> = [];

  for (let a = 1; a <= clients; a += 1) for (let k = 0; k < perClient; k += 1) tasks.push(() => request(ipN(range, a)));

  const started = Date.now();
  const statuses = tally(await pool(tasks));

  return { statuses, ms: Date.now() - started };
};
const nonce = async (ip: string) => {
  const r = await fetch(`${LOCAL}/issuers/truong-mau/nonce`, { method: 'POST', headers: { 'x-forwarded-for': ip } });

  await r.text();

  return r.status;
};

describe('B-1: the anonymous nonce endpoint', () => {
  it('one client, then the reviewer\'s 2006 requests from 34 addresses: each gets its share; a wallet still collects its diploma', async () => {
    const one = await flood(1, 59, nonce, 1);
    const many = await flood(34, 59, nonce, 2);

    console.log(`nonces, 1 client x 59: ${JSON.stringify(one.statuses)}; 34 clients x 59 (${many.ms} ms): ${JSON.stringify(many.statuses)}`);
    assert.deepEqual(one.statuses, { 200: NONCES_PER_CLIENT, 429: 59 - NONCES_PER_CLIENT });
    assert.deepEqual(many.statuses, { 200: 34 * NONCES_PER_CLIENT, 429: 34 * (59 - NONCES_PER_CLIENT) });

    // The victim: a student's wallet (its own address) goes through token, nonce and credential.
    const kind = 'state:live:vci-nonces:truong-mau';
    const liveBefore = await redis().zcard(kind);
    const offer = await newOffer(await login('sv003'));
    const { wallet } = newWallet();
    const resolved = await wallet.offers.resolve(offer.offerUri);

    assert.ok(resolved.ok);
    if (!resolved.ok) return;
    const accepted = await wallet.offers.accept(resolved.offer, { txCode: offer.txCode });

    assert.ok(accepted.ok, JSON.stringify(accepted));
    // Its nonce was used by the proof: its place is free again (and the redeemed offer's too).
    assert.equal(await redis().zcard(kind), liveBefore);
    assert.equal(await redis().zscore('state:live:vci-offers:truong-mau', offer.offerId), null);
    assert.equal(await nonce('203.0.113.51'), 200);
  });
});

describe('B-2: offers of the shared student accounts', () => {
  it('one sign-in from one address, then from ten (56 each, the reviewer\'s rate): they hold their share; another student gets an offer', async () => {
    const attacker = await login('sv001');
    const post = (ip: string) => call('POST', '/v1/demo/school/offers', { token: attacker, ip }).then((r) => r.status);
    const one = await flood(1, 56, post, 3);
    const ten = await flood(10, 56, post, 4);

    console.log(`offers as sv001, 1 client x 56: ${JSON.stringify(one.statuses)}; 10 clients x 56 (${ten.ms} ms): ${JSON.stringify(ten.statuses)}`);
    assert.deepEqual(one.statuses, { 201: OFFERS_PER_CLIENT, 429: 56 - OFFERS_PER_CLIENT });
    assert.deepEqual(ten.statuses, { 201: 10 * OFFERS_PER_CLIENT, 429: 10 * (56 - OFFERS_PER_CLIENT) });
    assert.equal(await redis().zcard('state:live:vci-offers:truong-mau'), 11 * OFFERS_PER_CLIENT);

    const victim = await call('POST', '/v1/demo/school/offers', { token: await login('sv002'), ip: '203.0.113.50' });

    assert.equal(victim.status, 201, JSON.stringify(victim.body));
  });
});

describe('B-3: verification session creation', () => {
  const create = (body: object) => (ip: string) => call('POST', '/v1/verification/sessions', { body, ip }).then((r) => r.status);
  const valid = { verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' };

  it('300 INVALID bodies from 10 addresses spend nothing; then valid floods from 1 and 10 addresses hold their share; a visitor still gets a session', async () => {
    const junk = await flood(10, 30, create({ verifier: 'x' }), 5);
    const afterJunk = await call('POST', '/v1/verification/sessions', { body: valid, ip: '203.0.113.52' });
    const one = await flood(1, 30, create(valid), 6);
    const ten = await flood(10, 30, create(valid), 7);
    const victim = await call('POST', '/v1/verification/sessions', { body: valid, ip: '203.0.113.53' });

    console.log(
      `sessions: 10 clients x 30 invalid: ${JSON.stringify(junk.statuses)}, then a visitor: ${afterJunk.status}; ` +
        `valid 1 client x 30: ${JSON.stringify(one.statuses)}; 10 clients x 30: ${JSON.stringify(ten.statuses)}; then a visitor: ${victim.status}`
    );
    assert.deepEqual(junk.statuses, { 400: 300 });
    assert.equal(afterJunk.status, 201);
    assert.deepEqual(one.statuses, { 201: SESSIONS_PER_CLIENT, 429: 30 - SESSIONS_PER_CLIENT });
    assert.deepEqual(ten.statuses, { 201: 10 * SESSIONS_PER_CLIENT, 429: 10 * (30 - SESSIONS_PER_CLIENT) });
    assert.equal(victim.status, 201);
  });
});

describe('B-4: two visitors on the same public student account', () => {
  it('keep their own offers, listings and revocations; neither sees nor revokes the other\'s', async () => {
    const [alice, bob] = [await login('sv002'), await login('sv002')];
    const [aliceOffer, bobOffer] = [await newOffer(alice), await newOffer(bob)];

    // Bob's offer did not end Alice's; neither reads the other's.
    assert.equal((await offerState(alice, aliceOffer.offerId)).body.status, 'pending');
    assert.equal((await offerState(bob, bobOffer.offerId)).body.status, 'pending');
    assert.equal((await offerState(bob, aliceOffer.offerId)).status, 404);
    assert.equal((await call('DELETE', `/v1/demo/school/offers/${aliceOffer.offerId}`, { token: bob })).status, 404);

    const collect = async (offer: typeof aliceOffer) => {
      const { wallet } = newWallet();
      const resolved = await wallet.offers.resolve(offer.offerUri);

      assert.ok(resolved.ok);
      if (!resolved.ok) throw new Error('unresolved');
      const accepted = await wallet.offers.accept(resolved.offer, { txCode: offer.txCode });

      assert.ok(accepted.ok, JSON.stringify(accepted));
    };

    await collect(aliceOffer);
    await collect(bobOffer);

    const list = async (token: string) => (await call('GET', '/v1/demo/school/credentials', { token })).body.items as Array<{ id: string; status: string; canRevoke: boolean }>;
    const [aliceItems, bobItems] = [await list(alice), await list(bob)];

    assert.equal(aliceItems.length, 1);
    assert.equal(bobItems.length, 1);
    assert.notEqual(aliceItems[0]!.id, bobItems[0]!.id);
    assert.deepEqual([aliceItems[0]!.status, aliceItems[0]!.canRevoke], ['valid', true]);
    // A third visitor on the account sees nothing of either.
    assert.deepEqual(await list(await login('sv002')), []);

    const revoke = (token: string, id: string) => call('POST', `/v1/demo/school/credentials/${id}/revoke`, { token });

    assert.deepEqual([(await revoke(bob, aliceItems[0]!.id)).status, (await revoke(bob, aliceItems[0]!.id)).body.code], [404, 'NOT_FOUND']);
    const revoked = await revoke(alice, aliceItems[0]!.id);

    assert.deepEqual([revoked.status, revoked.body.id, revoked.body.status], [200, aliceItems[0]!.id, 'revoked']);
    assert.ok(revoked.body.updatedAt);
    assert.deepEqual([(await revoke(alice, aliceItems[0]!.id)).status, (await revoke(alice, aliceItems[0]!.id)).body.code], [409, 'CONFLICT']);
    assert.deepEqual((await list(alice)).map((i) => [i.status, i.canRevoke]), [['revoked', false]]);
    assert.deepEqual((await list(bob)).map((i) => i.status), ['valid']);

    // Students only revoke; the registrar (its own password) keeps the full list and the status route.
    const registrar = await login('phongdaotao');
    assert.equal((await revoke(registrar, bobItems[0]!.id)).status, 403);
    const all = await list(registrar);
    assert.ok([aliceItems[0]!.id, bobItems[0]!.id].every((id) => all.some((i) => i.id === id)));
    const suspended = await call('POST', `/v1/issuers/truong-mau/credentials/${bobItems[0]!.id}/status`, { token: registrar, body: { status: 'suspended' } });
    assert.deepEqual([suspended.status, suspended.body.status], [200, 'suspended']);
    // A student token is not a registrar on the status route.
    assert.equal((await call('POST', `/v1/issuers/truong-mau/credentials/${bobItems[0]!.id}/status`, { token: bob, body: { status: 'valid' } })).status, 403);
  });
});

// The second review's IPv6 finding: a free routed /48 (a tunnel broker) holds 256 /56s and 65,536
// /64s. Before the /48 tier, 256 /56s × 5 offers filled the 500 offers and the next student, on
// IPv4, got 503; logins from many /64s each had their own 10/min.
const in48 = (net: number, i: number) => `2001:db8:${net.toString(16)}:${(i << 8).toString(16)}::1`;

describe('B-5: one IPv6 /48, 256 /56s asking for offers', () => {
  it('the /48 gets its share; an IPv4 student and an IPv6 student of another /48 still get offers', async () => {
    const attacker = await login('sv001');
    const live = () => redis().zcard('state:live:vci-offers:truong-mau');
    const before = await live();
    const tasks: Array<() => Promise<number>> = [];

    for (let i = 0; i < 256; i += 1) {
      for (let k = 0; k < OFFERS_PER_CLIENT; k += 1) tasks.push(() => call('POST', '/v1/demo/school/offers', { token: attacker, ip: in48(0xab, i) }).then((r) => r.status));
    }

    const statuses = tally(await pool(tasks));

    console.log(`offers from 256 /56s of one /48: ${JSON.stringify(statuses)}`);
    assert.deepEqual(statuses, { 201: NETWORK_SHARES * OFFERS_PER_CLIENT, 429: 256 * OFFERS_PER_CLIENT - NETWORK_SHARES * OFFERS_PER_CLIENT });
    assert.equal((await live()) - before, NETWORK_SHARES * OFFERS_PER_CLIENT);

    for (const ip of ['203.0.113.60', in48(0xcd, 1)]) {
      const victim = await call('POST', '/v1/demo/school/offers', { token: await login('sv002'), ip });

      assert.equal(victim.status, 201, `${ip}: ${JSON.stringify(victim.body)}`);
    }
  });
});

describe('B-6: sign-in from many /64s of one /48', () => {
  it('is throttled at the /48 bucket; another client still signs in to the same (public) account', async () => {
    const budget = RATE_LIMITS.login.limit * NETWORK_SHARES;
    const attempt = (ip: string, password = 'wrong-password') =>
      call('POST', '/v1/demo/school/login', { body: { username: 'sv003', password }, ip });
    const statuses: number[] = [];

    // One request per /64 (65,536 of them in a /48): the per-/64 limit never applies. One at a
    // time, so the two-at-once hashing does not answer 503.
    for (let i = 0; i <= budget; i += 1) statuses.push((await attempt(`2001:db8:77:${i.toString(16)}::1`)).status);

    assert.deepEqual(tally(statuses), { 401: budget, 429: 1 });

    const limited = await attempt('2001:db8:77:ffff::1', TEST_PORTAL_PASSWORD);

    assert.deepEqual([limited.status, limited.body.code], [429, 'RATE_LIMITED']);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await attempt('203.0.113.61', TEST_PORTAL_PASSWORD)).status, 201);
    assert.equal((await attempt('2001:db8:78::1', TEST_PORTAL_PASSWORD)).status, 201);
  });
});

describe('B-7: the /48 budget applies to routes that create state, not to reads', () => {
  it('polling from many /64s of one /48 beyond the old /48 read budget is served; the token endpoint is still limited per /48', async () => {
    const poll = (ip: string) => call('GET', '/v1/verification/sessions/AAAAAAAAAAAAAAAAAAAAAA', { ip }).then((r) => r.status);
    // A carrier's /48 pool: every phone its own /64, each polling (the reads' /48 budget used to be 4 × 300/min).
    const reads = tally(await pool(Array.from({ length: 4 * RATE_LIMITS.default.limit + 100 }, (_, i) => () => poll(`2001:db8:91:${i.toString(16)}::1`))));

    assert.deepEqual(reads, { 404: 4 * RATE_LIMITS.default.limit + 100 });
    // The per-client read limit still holds.
    const one = tally(await pool(Array.from({ length: RATE_LIMITS.default.limit + 1 }, () => () => poll('2001:db8:91:ffff::1'))));

    assert.deepEqual(one, { 404: RATE_LIMITS.default.limit, 429: 1 });

    const budget = RATE_LIMITS.token.limit * NETWORK_SHARES;
    const token = (ip: string) =>
      fetch(`${LOCAL}/issuers/truong-mau/token`, { method: 'POST', headers: { 'x-forwarded-for': ip, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=x' }).then(async (r) => (await r.text(), r.status));
    const writes = tally(await pool(Array.from({ length: budget + 1 }, (_, i) => () => token(`2001:db8:92:${i.toString(16)}::1`))));

    // Refused by the issuer (unsupported grant) up to the /48 budget, then by the /48 limiter.
    assert.deepEqual(writes, { 400: budget, 429: 1 });
  });
});
