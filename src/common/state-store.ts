import Redis from 'ioredis';

/**
 * Short-lived state with a TTL (docs/vc-api.md §2): portal sessions now; offers, nonces and
 * verifier sessions in the next phases (handed to the SDK's issuer and verifier). Values are
 * strings; callers serialise. Every method is a single atomic Redis command or transaction.
 */
export interface StateStore {
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Atomic get-and-delete: of concurrent callers exactly one receives the value. */
  take(key: string): Promise<string | null>;
  /** Increments a counter; the TTL is set when the counter is created and not extended later. */
  increment(key: string, ttlSeconds: number): Promise<number>;
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
    async increment(key, ttlSeconds) {
      const results = await redis.multi().incr(k(key)).expire(k(key), ttl(ttlSeconds), 'NX').exec();
      const [error, value] = results![0]!;

      if (error) throw error;

      return value as number;
    }
  };
}
