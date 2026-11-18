import { readFileSync, statSync } from 'node:fs';

import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { base64Decode, base64UrlEncode, verifyTrustListToken } from '@identra/sdk-core';
import { createTrustListService, type TrustListService } from '@identra/sdk-server';

import { createRedisStateStore } from '../common/state-store';
import { RedisService } from '../infrastructure/redis/redis.service';
import { PKI, Pki, TRUST_LIST_SERVICE } from './vc.providers';

const logger = new Logger('TrustList');
const LAST_TRUST_LIST_TOKEN = 'last-token';
const SKEW_SECONDS = 60;
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

async function signerFingerprint(pki: Pki): Promise<string> {
  const signer = await pki.keyStore.trustListSigner();

  return base64UrlEncode(await pki.hasher.sha256(base64Decode(signer.x5c![0]!)));
}

/**
 * The last token kept in Redis only raises the next iat, so it must not be trusted blindly:
 * it is used only when it verifies against the pinned root, was signed by the current
 * trust-list signer, and its iat is not in the future. Anything else is ignored and logged.
 */
export async function verifiedLastToken(token: string | null, pki: Pki): Promise<string | undefined> {
  if (token === null) return undefined;

  const now = pki.clock.now();
  const verified = await verifyTrustListToken(token, { chainValidator: pki.chainValidator, verifier: pki.verifier, now });
  const reason = !verified.ok
    ? verified.reason
    : verified.signerFingerprint !== (await signerFingerprint(pki))
      ? 'other signer'
      : verified.payload.iat > now.getTime() / 1000 + SKEW_SECONDS
        ? 'iat in the future'
        : null;

  if (reason !== null) {
    logger.warn(`Ignoring the stored last trust-list token (${reason})`);

    return undefined;
  }

  return token;
}

export const TRUST_LIST_MONITOR = Symbol('TRUST_LIST_MONITOR');
export interface TrustListMonitor {
  /** `up` only when the token being served verifies, its iat is not ahead and it lives 2 h more. */
  check(): Promise<'up' | 'down'>;
}

export const trustListProviders: Provider[] = [
  {
    provide: TRUST_LIST_SERVICE,
    inject: [PKI, ConfigService, RedisService],
    useFactory: async (pki: Pki, config: ConfigService, redis: RedisService): Promise<TrustListService> => {
      // The last served token survives restarts, so the next iat is always greater (ADR-0019 §4).
      const store = createRedisStateStore(redis.getClient(), 'trust-list');
      const lastToken = await verifiedLastToken(await store.get(LAST_TRUST_LIST_TOKEN).catch(() => null), pki);
      let lastWarning = 0;
      const service = createTrustListService({
        source: trustListSource(config.getOrThrow<string>('IDENTRA_TRUST_LIST_SOURCE')),
        keyStore: pki.keyStore,
        clock: pki.clock,
        ...(lastToken ? { lastToken } : {}),
        // The validator's detail can quote the content: log only that it happened, once a minute.
        onError: () => {
          if (Date.now() - lastWarning < WARN_EVERY_MS) return;

          lastWarning = Date.now();
          logger.warn('Trust-list source refused; still serving the last good token');
        }
      });
      let saved = lastToken;

      return {
        async token() {
          const token = await service.token();

          if (token !== saved) {
            saved = token;
            await store.put(LAST_TRUST_LIST_TOKEN, token, 2 * 86_400).catch(() => undefined);
          }

          return token;
        }
      };
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

            if (r.ok && r.payload.iat <= nowMs / 1000 + SKEW_SECONDS && r.payload.exp > nowMs / 1000 + 2 * 3600) state = 'up';
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
