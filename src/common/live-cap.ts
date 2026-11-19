import { randomBytes } from 'node:crypto';

import Redis from 'ioredis';

// KEYS[1] the sorted set; ARGV: now (ms), expiry of the new member (ms), cap, member, key TTL (ms).
// Prune what has expired, refuse when full (answering the oldest expiry), else add. One script, so
// concurrent callers can never exceed the cap; entries expire by score and the key by its TTL, so
// a crash leaves nothing that needs repairing.
const RESERVE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return {0, redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2]}
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {1, ARGV[2]}`;

export type Reservation = { ok: true; member: string } | { ok: false; retryAfterSeconds: number };

/**
 * A global cap on live entries of one kind of protocol state (docs/vc-api.md §8): a Redis sorted
 * set of members scored by their expiry on `clock` (the feature's own clock, so tests can move it).
 */
export interface LiveCap {
  reserve(member?: string): Promise<Reservation>;
  release(member: string): Promise<void>;
  /** Members still live, oldest first. */
  live(): Promise<string[]>;
  clear(): Promise<void>;
}

export function createLiveCap(
  redis: Redis,
  name: string,
  options: { max: number; lifetimeSeconds: number; clock: { now(): Date } }
): LiveCap {
  const key = `state:live:${name}`;
  const lifetimeMs = options.lifetimeSeconds * 1000;
  const now = () => options.clock.now().getTime();

  return {
    async reserve(member = randomBytes(16).toString('base64url')) {
      const t = now();
      const [ok, score] = (await redis.eval(RESERVE, 1, key, t, t + lifetimeMs, options.max, member, lifetimeMs)) as [number, string];

      if (ok === 1) return { ok: true, member };

      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((Number(score) - t) / 1000)) };
    },
    async release(member) {
      await redis.zrem(key, member);
    },
    live: () => redis.zrangebyscore(key, `(${now()}`, '+inf'),
    async clear() {
      await redis.del(key);
    }
  };
}
