import { normalizeIp } from '@nestjs/throttler';
import Redis from 'ioredis';

// Keys of a kind: `state:live:<kind>` (sorted set of ids scored by expiry, the global cap),
// `…:owners` (hash id → the client's sorted set, `<id>:net` → its /48's) and the shares:
// `…:client:<client>` (an IPv4 address or IPv6 /56) and, for IPv6, `…:net:<network>` (its /48).
// KEYS[1] global, KEYS[2] owners, KEYS[3] client set, KEYS[4] /48 set (each absent when not capped).
// ARGV: now (ms), expiry of the new id (ms), global cap, id, key TTL (ms), client cap, /48 cap.
// One script, so concurrent callers can never exceed any cap. Expired ids are pruned by score;
// every key gets a TTL of one lifetime on every reservation, so a crash leaves nothing that needs
// repairing (the newest id expires with its keys).
const RESERVE = `
local now = tonumber(ARGV[1])
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now)) do
  redis.call('HDEL', KEYS[2], id, id .. ':net')
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
for i = 3, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i + 3]) then
    return {0, redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')[2], 'client'}
  end
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return {0, redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2], 'global'}
end
for i = 3, #KEYS do
  redis.call('ZADD', KEYS[i], ARGV[2], ARGV[4])
  redis.call('PEXPIRE', KEYS[i], ARGV[5])
  redis.call('HSET', KEYS[2], i == 3 and ARGV[4] or ARGV[4] .. ':net', KEYS[i])
  redis.call('PEXPIRE', KEYS[2], ARGV[5])
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {1}`;

// KEYS[1] global, KEYS[2] owners; ARGV[1] id. The share sets' names come from the owners hash.
// RELEASE and CLEAR write keys not passed in KEYS: correct on the one standalone Redis of the
// compose files; under Redis Cluster every key a script touches must be declared (and hash to
// one slot, e.g. a `{kind}` hash tag), so these would need the share keys passed in.
const RELEASE = `
for _, field in ipairs({ARGV[1], ARGV[1] .. ':net'}) do
  local set = redis.call('HGET', KEYS[2], field)
  if set then
    redis.call('ZREM', set, ARGV[1])
    redis.call('HDEL', KEYS[2], field)
  end
end
return redis.call('ZREM', KEYS[1], ARGV[1])`;

const CLEAR = `
for _, set in ipairs(redis.call('HVALS', KEYS[2])) do redis.call('DEL', set) end
return redis.call('DEL', KEYS[1], KEYS[2])`;

/** `client`: this client (or its /48) already holds its share (answer 429); `global`: everybody's cap is full (503). */
export type Reservation = { ok: true } | { ok: false; scope: 'client' | 'global'; retryAfterSeconds: number };

export interface ReserveOptions {
  /** Live ids of this kind across all clients: the memory bound. */
  cap: number;
  /** The share of one client (`clientOf`) inside `cap`; its IPv6 /48 holds NETWORK_SHARES × `cap`. */
  perClient?: Client & { cap: number };
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

/** A client of the shares: `key` its own share, `network` (IPv6 only) the /48 it is also counted in. */
export interface Client {
  key: string;
  network?: string;
}

/**
 * The /48 share of an IPv6 client, in /56 shares: a /48 (free from tunnel brokers) holds 256 /56s,
 * which must not buy 256 shares; a few customers of one ISP block still get theirs.
 */
export const NETWORK_SHARES = 4;

/** The IPv6 /48 of an address (null for IPv4, IPv4-mapped and anything unparseable). */
export function networkOf(ip: string | undefined): string | null {
  const network = normalizeIp(ip ?? '', 48);

  return network.endsWith('/48') ? network : null;
}

/**
 * The client a share belongs to: an IPv4 address, or an IPv6 /56 (one customer's allocation at
 * most ISPs, coarser than the /64 of the rate limits: a /56 holds 256 /64s, which must not buy 256
 * shares) inside its /48 (`network`, NETWORK_SHARES shares). `ip` is req.ip, the address nginx
 * passed on.
 */
export function clientOf(ip: string | undefined): Client {
  const network = networkOf(ip);

  return { key: normalizeIp(ip ?? 'unknown', 56), ...(network ? { network } : {}) };
}

export function createLiveCaps(redis: Redis, clock: { now(): Date }): LiveCaps {
  const key = (kind: string) => `state:live:${kind}`;
  const owners = (kind: string) => `${key(kind)}:owners`;

  return {
    async reserve(kind, id, ttlSeconds, { cap, perClient }) {
      const now = clock.now().getTime();
      const ttlMs = ttlSeconds * 1000;
      const keys = [
        key(kind),
        owners(kind),
        ...(perClient ? [`${key(kind)}:client:${perClient.key}`] : []),
        ...(perClient?.network ? [`${key(kind)}:net:${perClient.network}`] : [])
      ];
      const shares = [perClient?.cap ?? 0, (perClient?.cap ?? 0) * NETWORK_SHARES];
      const [ok, score, scope] = (await redis.eval(RESERVE, keys.length, ...keys, now, now + ttlMs, cap, id, ttlMs, ...shares)) as [
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
