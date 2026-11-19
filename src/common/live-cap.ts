import { normalizeIp } from '@nestjs/throttler';
import Redis from 'ioredis';

// Keys of a kind: `state:live:<kind>` (sorted set of ids scored by expiry, the global cap),
// `…:owners` (hash id → the client's sorted set) and `…:client:<client>` (the client's share).
// KEYS[1] global, KEYS[2] owners, KEYS[3] client set (absent without a per-client cap).
// ARGV: now (ms), expiry of the new id (ms), global cap, id, key TTL (ms), client cap.
// One script, so concurrent callers can never exceed either cap. Expired ids are pruned by score;
// every key gets a TTL of one lifetime on every reservation, so a crash leaves nothing that needs
// repairing (the newest id expires with its keys).
const RESERVE = `
local now = tonumber(ARGV[1])
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)) do
  redis.call('HDEL', KEYS[2], id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if KEYS[3] then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
  if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[6]) then
    return {0, redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')[2], 'client'}
  end
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return {0, redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2], 'global'}
end
if KEYS[3] then
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[4])
  redis.call('PEXPIRE', KEYS[3], ARGV[5])
  redis.call('HSET', KEYS[2], ARGV[4], KEYS[3])
  redis.call('PEXPIRE', KEYS[2], ARGV[5])
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {1}`;

// KEYS[1] global, KEYS[2] owners; ARGV[1] id. The client set's name comes from the owners hash.
const RELEASE = `
local client = redis.call('HGET', KEYS[2], ARGV[1])
if client then
  redis.call('ZREM', client, ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
end
return redis.call('ZREM', KEYS[1], ARGV[1])`;

const CLEAR = `
for _, client in ipairs(redis.call('HVALS', KEYS[2])) do redis.call('DEL', client) end
return redis.call('DEL', KEYS[1], KEYS[2])`;

/** `client`: this client already holds its share (answer 429); `global`: everybody's cap is full (503). */
export type Reservation = { ok: true } | { ok: false; scope: 'client' | 'global'; retryAfterSeconds: number };

export interface ReserveOptions {
  /** Live ids of this kind across all clients: the memory bound. */
  cap: number;
  /** The share of one client (`clientOf`) inside `cap`. */
  perClient?: { key: string; cap: number };
}

/**
 * Caps on live entries of anonymous or public protocol state (docs/vc-api.md §8): a global cap
 * (the Redis memory bound) and, inside it, a per-client share, enforced together in one atomic
 * reservation. An id lives `ttlSeconds` on `clock` (the feature's own clock, so tests can move it)
 * unless released earlier (consumed, cancelled, a failed creation).
 */
export interface LiveCaps {
  reserve(kind: string, id: string, ttlSeconds: number, options: ReserveOptions): Promise<Reservation>;
  release(kind: string, id: string): Promise<void>;
  /** Ids still live, oldest first. */
  live(kind: string): Promise<string[]>;
  clear(kind: string): Promise<void>;
}

/**
 * The client a share belongs to: an IPv4 address, or an IPv6 /56 (one customer's allocation at
 * most ISPs, coarser than the /64 of the rate limits: a /56 holds 256 /64s, which must not buy 256
 * shares). `ip` is req.ip, the address nginx passed on.
 */
export const clientOf = (ip: string | undefined): string => normalizeIp(ip ?? 'unknown', 56);

export function createLiveCaps(redis: Redis, clock: { now(): Date }): LiveCaps {
  const key = (kind: string) => `state:live:${kind}`;
  const owners = (kind: string) => `${key(kind)}:owners`;

  return {
    async reserve(kind, id, ttlSeconds, { cap, perClient }) {
      const now = clock.now().getTime();
      const ttlMs = ttlSeconds * 1000;
      const keys = [key(kind), owners(kind), ...(perClient ? [`${key(kind)}:client:${perClient.key}`] : [])];
      const [ok, score, scope] = (await redis.eval(RESERVE, keys.length, ...keys, now, now + ttlMs, cap, id, ttlMs, perClient?.cap ?? 0)) as [
        number,
        string?,
        ('client' | 'global')?
      ];

      if (ok === 1) return { ok: true };

      return { ok: false, scope: scope!, retryAfterSeconds: Math.max(1, Math.ceil((Number(score) - now) / 1000)) };
    },
    async release(kind, id) {
      await redis.eval(RELEASE, 2, key(kind), owners(kind), id);
    },
    live: (kind) => redis.zrangebyscore(key(kind), `(${clock.now().getTime()}`, '+inf'),
    async clear(kind) {
      await redis.eval(CLEAR, 2, key(kind), owners(kind));
    }
  };
}
