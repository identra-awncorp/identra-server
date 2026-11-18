import type { ProtocolStateStore } from '@identra/sdk-server';
import Redis from 'ioredis';

/**
 * Short-lived state with a TTL (docs/vc-api.md §2): portal sessions, and the SDK's protocol
 * state (its ProtocolStateStore: offers, codes, nonces, access tokens). Values are strings;
 * callers serialise. Every method is a single atomic Redis command or transaction:
 * `take` = GETDEL, `increment` = INCR + EXPIRE NX in one MULTI.
 */
export interface StateStore extends ProtocolStateStore {
  /** Stores `value` and returns the previous value, atomically (SET … GET). */
  swap(key: string, value: string, ttlSeconds: number): Promise<string | null>;
}

/** All keys live under `state:<namespace>:` so stores of different features cannot collide. */
export function createRedisStateStore(redis: Redis, namespace: string): StateStore {
  if (!/^[a-z0-9-]+$/.test(namespace)) {
    throw new TypeError('namespace must be lower-case letters, digits and hyphens');
  }

  const k = (key: string) => `state:${namespace}:${key}`;
  const ttl = (seconds: number) => {
    if (!Number.isSafeInteger(seconds) || seconds < 1) throw new TypeError('ttlSeconds must be a positive integer');

    return seconds;
  };

  return {
    async put(key, value, ttlSeconds) {
      await redis.set(k(key), value, 'EX', ttl(ttlSeconds));
    },
    get: (key) => redis.get(k(key)),
    take: (key) => redis.getdel(k(key)),
    swap: (key, value, ttlSeconds) => redis.set(k(key), value, 'EX', ttl(ttlSeconds), 'GET'),
    async increment(key, ttlSeconds) {
      const results = await redis.multi().incr(k(key)).expire(k(key), ttl(ttlSeconds), 'NX').exec();
      const [error, value] = results![0]!;

      if (error) throw error;

      return value as number;
    }
  };
}
