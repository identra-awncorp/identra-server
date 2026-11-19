// The live-state caps (src/common/live-cap.ts) against the test Redis: global cap, per-client
// share (and the /48 share of IPv6 clients) in the same atomic reservation, release, pruning, and
// self-expiring keys.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import Redis from 'ioredis';

import { clientOf, createLiveCaps, NETWORK_SHARES } from '../src/common/live-cap';
import { NONCES_PER_CLIENT, OFFER_RECORDS_PER_CLIENT, OFFER_RECORDS_PER_LIVE_OFFER, OFFERS_PER_CLIENT } from '../src/vc/issuers';
import { SESSION_RECORDS_PER_CLIENT, SESSION_RECORDS_PER_LIVE_SESSION, SESSIONS_PER_CLIENT } from '../src/vc/verification.controllers';
import { adjustableClock } from './e2e-world';

const clock = adjustableClock();
let redis: Redis;
let caps: ReturnType<typeof createLiveCaps>;
let seq = 0;
const kind = () => `test-cap-${(seq += 1)}`;
const keysOf = (k: string) => redis.keys(`state:live:${k}*`);

before(() => {
  redis = new Redis(process.env.REDIS_URL!);
  caps = createLiveCaps(redis, clock);
});

after(() => redis.disconnect());

describe('live caps', () => {
  it('a client holds at most its share; the others keep theirs until the global cap', async () => {
    const k = kind();
    const reserve = (id: string, client: string) => caps.reserve(k, id, 60, { cap: 5, perClient: { key: client, cap: 2 } });

    assert.deepEqual(await reserve('a1', 'A'), { ok: true });
    assert.deepEqual(await reserve('a2', 'A'), { ok: true });
    assert.deepEqual(await reserve('a3', 'A'), { ok: false, scope: 'client', retryAfterSeconds: 60 });
    assert.deepEqual(await reserve('b1', 'B'), { ok: true });
    assert.deepEqual(await reserve('b2', 'B'), { ok: true });
    assert.deepEqual(await reserve('c1', 'C'), { ok: true });
    assert.deepEqual(await reserve('d1', 'D'), { ok: false, scope: 'global', retryAfterSeconds: 60 });
    assert.deepEqual(await caps.live(k), ['a1', 'a2', 'b1', 'b2', 'c1']);

    // Released: both counts go down, so A and D each get a place again.
    await caps.release(k, 'a1');
    assert.deepEqual(await reserve('a3', 'A'), { ok: true });
    await caps.release(k, 'c1');
    assert.deepEqual(await reserve('d1', 'D'), { ok: true });
    assert.equal(await redis.zcard(`state:live:${k}:client:C`), 0);
  });

  it('200 concurrent reservations of one client: exactly its share; of 200 clients: exactly the cap', async () => {
    const one = kind();
    const many = kind();
    const a = await Promise.all(Array.from({ length: 200 }, (_, i) => caps.reserve(one, `x${i}`, 60, { cap: 100, perClient: { key: 'A', cap: 7 } })));
    const b = await Promise.all(Array.from({ length: 200 }, (_, i) => caps.reserve(many, `x${i}`, 60, { cap: 100, perClient: { key: `c${i}`, cap: 7 } })));

    assert.equal(a.filter((r) => r.ok).length, 7);
    assert.equal(b.filter((r) => r.ok).length, 100);
    assert.equal(await redis.zcard(`state:live:${many}`), 100);
    assert.equal(await redis.hlen(`state:live:${many}:owners`), 100);
  });

  it('every key it writes expires on its own (a crash leaves nothing behind), and expired ids are pruned', async () => {
    const k = kind();

    await caps.reserve(k, 'a', 30, { cap: 5, perClient: { key: 'A', cap: 2 } });
    await caps.reserve(k, 'n', 30, { cap: 5 });

    const keys = await keysOf(k);

    assert.equal(keys.length, 3);
    for (const key of keys) {
      const ttl = await redis.pttl(key);

      assert.ok(ttl > 25_000 && ttl <= 30_000, `${key}: ${ttl}`);
    }

    clock.advance(31);
    await caps.reserve(k, 'b', 30, { cap: 5, perClient: { key: 'B', cap: 2 } });
    assert.deepEqual(await caps.live(k), ['b']);
    assert.deepEqual(await redis.hkeys(`state:live:${k}:owners`), ['b']);
    // A's share is free again (its own set prunes by score; its key expires by TTL).
    assert.deepEqual(await caps.reserve(k, 'a2', 30, { cap: 5, perClient: { key: 'A', cap: 1 } }), { ok: true });
    clock.reset();
  });

  it('clear() removes the kind with every client share', async () => {
    const k = kind();

    for (const c of ['A', 'B']) await caps.reserve(k, c, 30, { cap: 5, perClient: { key: c, cap: 2 } });
    await caps.clear(k);
    assert.deepEqual(await keysOf(k), []);
  });

  it('a client is an IPv4 address (one level) or an IPv6 /56 inside its /48', () => {
    assert.deepEqual(clientOf('203.0.113.7'), { key: '203.0.113.7' });
    assert.deepEqual(clientOf('::ffff:203.0.113.7'), clientOf('203.0.113.7'));
    assert.deepEqual(clientOf('2001:db8:1:2ff::1'), clientOf('2001:db8:1:200::9'));
    assert.notEqual(clientOf('2001:db8:1:2ff::1').key, clientOf('2001:db8:1:300::1').key);
    assert.deepEqual(clientOf('2001:db8:1:2ff::1'), { key: '2001:db8:1:200::/56', network: '2001:db8:1::/48' });
    assert.equal(clientOf('2001:db8:1:ffff::1').network, '2001:db8:1::/48');
    assert.notEqual(clientOf('2001:db8:2::1').network, '2001:db8:1::/48');
  });
});

// The /56 of the i-th customer inside one /48 (2001:db8:<net>::/48 holds 256).
const in48 = (net: number, i: number) => `2001:db8:${net.toString(16)}:${(i << 8).toString(16)}::1`;

describe('one IPv6 /48 (256 /56s) against the production caps', () => {
  const production = [
    ['offers', 500, OFFERS_PER_CLIENT],
    ['offer records', 500 * OFFER_RECORDS_PER_LIVE_OFFER, OFFER_RECORDS_PER_CLIENT],
    ['nonces', 2000, NONCES_PER_CLIENT],
    ['verification sessions', 2000, SESSIONS_PER_CLIENT],
    ['session records', 2000 * SESSION_RECORDS_PER_LIVE_SESSION, SESSION_RECORDS_PER_CLIENT]
  ] as const;

  for (const [name, cap, share] of production) {
    it(`${name}: every /56 of the /48 asks for its full share (${share}); the /48 gets ${NETWORK_SHARES * share} of ${cap}, others are still served`, async () => {
      const k = kind();
      const reserve = (id: string, ip: string) => caps.reserve(k, id, 300, { cap, perClient: { ...clientOf(ip), cap: share } });
      const attack = await Promise.all(Array.from({ length: 256 * share }, (_, n) => reserve(`a${n}`, in48(0xab, n % 256))));
      const granted = attack.filter((r) => r.ok).length;

      // Before: 256 × share, more than the cap; the reviewer's IPv4 student was then refused (global).
      assert.equal(granted, NETWORK_SHARES * share);
      assert.ok(attack.filter((r) => !r.ok).every((r) => !r.ok && r.scope === 'client' && r.retryAfterSeconds > 0));
      assert.equal(await redis.zcard(`state:live:${k}`), NETWORK_SHARES * share);

      // An unrelated IPv4 client and an IPv6 client of another /48 each still get their full share.
      for (const [who, ip] of [['v4', '192.0.2.10'], ['v6', in48(0xcd, 1)]] as const) {
        const own = await Promise.all(Array.from({ length: share }, (_, n) => reserve(`${who}${n}`, ip)));

        assert.ok(own.every((r) => r.ok), `${who}: ${JSON.stringify(own.find((r) => !r.ok))}`);
      }
    });
  }

  it('a second /56 of the same /48 keeps its own share until the /48 share is used; a release frees both levels', async () => {
    const k = kind();
    const reserve = (id: string, ip: string) => caps.reserve(k, id, 60, { cap: 500, perClient: { ...clientOf(ip), cap: 5 } });

    for (let n = 0; n < 5; n += 1) assert.deepEqual(await reserve(`a${n}`, in48(0xef, 0)), { ok: true });
    assert.equal((await reserve('a5', in48(0xef, 0))).ok, false);
    // Its neighbours in the /48 each get a /56 share, up to NETWORK_SHARES of them.
    for (let c = 1; c < NETWORK_SHARES; c += 1) {
      for (let n = 0; n < 5; n += 1) assert.deepEqual(await reserve(`c${c}-${n}`, in48(0xef, c)), { ok: true });
    }

    const late = in48(0xef, NETWORK_SHARES);

    assert.deepEqual(await reserve('late', late), { ok: false, scope: 'client', retryAfterSeconds: 60 });
    await caps.release(k, 'a0');
    assert.deepEqual(await reserve('late', late), { ok: true });
    assert.equal(await redis.zcard(`state:live:${k}:client:${clientOf(late).key}`), 1);
    assert.equal(await redis.zcard(`state:live:${k}:net:${clientOf(late).network}`), NETWORK_SHARES * 5);
  });

  it('both levels expire and are released: every key has a TTL, nothing is left once all ids are gone', async () => {
    const k = kind();
    const reserve = (id: string, ip: string) => caps.reserve(k, id, 30, { cap: 50, perClient: { ...clientOf(ip), cap: 1 } });

    for (let c = 0; c < NETWORK_SHARES; c += 1) assert.deepEqual(await reserve(`x${c}`, in48(0x77, c)), { ok: true });
    assert.equal((await reserve('y', in48(0x77, 200))).ok, false, 'the /48 holds its share');

    const keys = await keysOf(k);

    // Global, owners, the /48 and one set per /56.
    assert.equal(keys.length, 3 + NETWORK_SHARES);
    for (const key of keys) {
      const ttl = await redis.pttl(key);

      assert.ok(ttl > 25_000 && ttl <= 30_000, `${key}: ${ttl}`);
    }

    // Expired at both levels: a new /56 of the /48 is served, and only its id is left anywhere.
    clock.advance(31);
    assert.deepEqual(await reserve('y', in48(0x77, 200)), { ok: true });
    assert.deepEqual(await caps.live(k), ['y']);
    assert.deepEqual((await redis.hkeys(`state:live:${k}:owners`)).sort(), ['y', 'y:net']);
    assert.deepEqual(await redis.zrange(`state:live:${k}:net:${clientOf(in48(0x77, 0)).network}`, 0, -1), ['y']);

    // Released: the global set, the owners hash and the /48 set are empty (so gone). Left: only the
    // first /56 sets, holding expired ids until their own TTL ends.
    await caps.release(k, 'y');
    const left = await keysOf(k);

    assert.equal(left.length, NETWORK_SHARES);
    for (const key of left) {
      assert.match(key, /:client:/);
      assert.ok((await redis.pttl(key)) > 0, key);
      assert.equal(await redis.zcount(key, `(${clock.now().getTime()}`, '+inf'), 0, key);
    }
    clock.reset();
  });

  it('clear() removes IPv6 shares at both levels', async () => {
    const k = kind();

    for (let c = 0; c < 3; c += 1) await caps.reserve(k, `z${c}`, 30, { cap: 5, perClient: { ...clientOf(in48(0x99, c)), cap: 2 } });
    await caps.clear(k);
    assert.deepEqual(await keysOf(k), []);
  });
});
