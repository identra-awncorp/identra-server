import { readFileSync, statSync } from 'node:fs';

import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyTrustListToken } from '@identra/sdk-core';
import { createTrustListService, type LastIatStore, type TrustListService } from '@identra/sdk-server';

import { RedisService } from '../infrastructure/redis/redis.service';
import { PKI, Pki, TRUST_LIST_SERVICE } from './vc.providers';

const logger = new Logger('TrustList');
const LAST_IAT_KEY = 'state:trust-list:last-iat';
const SKEW_SECONDS = 60;

/**
 * The last signed iat across restarts (ADR-0019 §4), on Redis without a TTL. Best effort: the SDK
 * fails the call when the store fails, which with Redis down would stop the trust list (and the
 * startup). Here a failed read counts as none and a failed write is logged; the in-process iat
 * stays strictly increasing, and only a restart in the same second during a Redis outage could
 * repeat an iat (verifiers then keep their copy). The SDK ignores a stored iat > 60 s ahead.
 */
export function redisLastIatStore(redis: RedisService): LastIatStore {
  return {
    async get() {
      const value = await redis.getClient().get(LAST_IAT_KEY).catch(() => null);

      return value !== null && /^[0-9]{1,12}$/.test(value) ? Number(value) : null;
    },
    async set(iat) {
      await redis
        .getClient()
        .set(LAST_IAT_KEY, String(iat))
        .catch(() => logger.warn('Could not record the trust-list iat in Redis'));
    }
  };
}
const WARN_EVERY_MS = 60_000;

/**
 * The trust-list content. Re-read when the file changes: the cache key is mtime, ctime, size and
 * inode, so an edit that keeps the mtime (or a file swapped in by rename) is still noticed. A file
 * that cannot be read or parsed throws (the service keeps serving its last good token); the error
 * says nothing about the content.
 */
export function trustListSource(path: string): () => unknown {
  let cached: { key: string; value: unknown } | undefined;

  return () => {
    try {
      const st = statSync(path);
      const key = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;

      if (cached?.key === key) return cached.value;

      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));

      cached = { key, value };

      return value;
    } catch {
      cached = undefined;
      throw new Error('the trust-list source file is missing or not valid JSON');
    }
  };
}

export const TRUST_LIST_MONITOR = Symbol('TRUST_LIST_MONITOR');
export interface TrustListMonitor {
  /**
   * `up` only when the token being served verifies, and (from the service's current()) its iat is
   * not ahead, it lives 2 h more and its signer certificate is still valid.
   */
  check(): Promise<'up' | 'down'>;
}

export const trustListProviders: Provider[] = [
  {
    provide: TRUST_LIST_SERVICE,
    inject: [PKI, ConfigService, RedisService],
    useFactory: (pki: Pki, config: ConfigService, redis: RedisService): TrustListService => {
      let lastWarning = 0;

      return createTrustListService({
        source: trustListSource(config.getOrThrow<string>('IDENTRA_TRUST_LIST_SOURCE')),
        keyStore: pki.keyStore,
        clock: pki.clock,
        lastIatStore: redisLastIatStore(redis),
        // The reason only, never content; at most once a minute.
        onError: (reason) => {
          if (Date.now() - lastWarning < WARN_EVERY_MS) return;

          lastWarning = Date.now();
          logger.warn(`Trust list not re-signed (${reason}); serving the held token`);
        }
      });
    }
  },
  {
    provide: TRUST_LIST_MONITOR,
    inject: [PKI, TRUST_LIST_SERVICE],
    useFactory: (pki: Pki, trustList: TrustListService): TrustListMonitor => {
      let verdict: { token: string; state: 'up' | 'down'; at: number } | undefined;
      let reported: 'up' | 'down' | undefined;

      return {
        async check() {
          const nowMs = pki.clock.now().getTime();
          let state: 'up' | 'down' = 'down';
          let token: string | undefined;

          try {
            token = await trustList.token();

            // The verdict on one token is kept for 60 s; a new token is verified at once.
            if (verdict?.token === token && nowMs - verdict.at < 60_000 && nowMs >= verdict.at) return verdict.state;

            const r = await verifyTrustListToken(token, { chainValidator: pki.chainValidator, verifier: pki.verifier, now: new Date(nowMs) });

            const held = trustList.current();
            const nowS = nowMs / 1000;

            if (
              r.ok &&
              held !== null &&
              held.iat <= nowS + SKEW_SECONDS &&
              held.exp > nowS + 2 * 3600 &&
              held.signerNotAfter > nowS
            ) {
              state = 'up';
            }
          } catch {
            state = 'down';
          }

          verdict = token === undefined ? undefined : { token, state, at: nowMs };

          if (state !== reported) {
            if (state === 'down') logger.warn('The served trust list does not verify, is ahead of the clock or expires within 2 hours');
            else if (reported !== undefined) logger.log('The served trust list verifies again');
            reported = state;
          }

          return state;
        }
      };
    }
  }
];
