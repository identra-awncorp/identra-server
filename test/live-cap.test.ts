// The live-state caps (src/common/live-cap.ts) against the test Redis: global cap, per-client
// share in the same atomic reservation, release, pruning, and self-expiring keys.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import Redis from 'ioredis';

import { clientOf, createLiveCaps } from '../src/common/live-cap';
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

  it('a client is an IPv4 address or an IPv6 /56', () => {
    assert.equal(clientOf('203.0.113.7'), '203.0.113.7');
    assert.equal(clientOf('::ffff:203.0.113.7'), clientOf('203.0.113.7'));
    assert.equal(clientOf('2001:db8:1:2ff::1'), clientOf('2001:db8:1:200::9'));
    assert.notEqual(clientOf('2001:db8:1:2ff::1'), clientOf('2001:db8:1:300::1'));
  });
});
