import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createRedisStateStore } from '../common/state-store';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import {
  createCertificateChainValidator,
  createSignedTrustListRegistry,
  createStatusListChecker,
  type CertificateChainValidator,
  type Clock,
  type HttpFetch
} from '@identra/sdk-core';
import { webCryptoHasher, webCryptoRandom, webCryptoVerifier } from '@identra/sdk-core/webcrypto';
import {
  createFileKeyStore,
  createStatusListService,
  createTrustListService,
  type IssuerKeyStore,
  type StatusListService,
  type TrustListService
} from '@identra/sdk-server';
import { createOwnFetch } from './own-fetch';
import { createPrismaStatusListStorage } from './status-storage';

export const PKI = Symbol('PKI');
/** The clock of signing and verification (status lists, trust list, chain validation). */
export const CLOCK = Symbol('CLOCK');
/**
 * The clock of the OpenID4VCI issuers (offer, token and proof lifetimes). The real clock; a
 * separate token only so tests can move offers past their 10 minutes without touching the lists.
 */
export const ISSUER_CLOCK = Symbol('ISSUER_CLOCK');
export const TRUST_LIST_SERVICE = Symbol('TRUST_LIST_SERVICE');
export const STATUS_LIST_SERVICE = Symbol('STATUS_LIST_SERVICE');
export const OWN_FETCH = Symbol('OWN_FETCH');
export const TRUST_REGISTRY = Symbol('TRUST_REGISTRY');
export const STATUS_CHECKER = Symbol('STATUS_CHECKER');

/** Everything verification and signing need, built once at startup from IDENTRA_KEYS_DIR. */
export interface Pki {
  baseUrl: string;
  issuerUri: (name: string) => string;
  keyStore: IssuerKeyStore;
  trustedRoots: Uint8Array[];
  chainValidator: CertificateChainValidator;
  verifier: typeof webCryptoVerifier;
  hasher: typeof webCryptoHasher;
  random: typeof webCryptoRandom;
  clock: Clock;
}

const logger = new Logger('Pki');
const PURPOSE_FILES = { vc: ['vc', 'vc-product'], status: ['status'], request: ['request'] } as const;

/**
 * Loads every key of the store (each organisation's keys found on disk and the trust-list
 * signer), so a missing, unreadable or invalid key stops the startup instead of the first
 * request. Messages name files and SDK error codes only, never key material.
 */
async function loadPki(config: ConfigService, clock: Clock): Promise<Pki> {
  const dir = config.getOrThrow<string>('IDENTRA_KEYS_DIR');
  const baseUrl = config.getOrThrow<string>('IDENTRA_PUBLIC_BASE_URL');

  try {
    const keyStore = createFileKeyStore(dir);
    const trustedRoots = keyStore.trustedRoots();
    const organisations = readdirSync(join(dir, 'orgs'), { withFileTypes: true }).filter((e) => e.isDirectory());

    await keyStore.trustListSigner();

    for (const org of organisations) {
      const files = readdirSync(join(dir, 'orgs', org.name));

      for (const [purpose, names] of Object.entries(PURPOSE_FILES)) {
        if (names.some((name) => files.includes(`${name}.key.pem`))) {
          await keyStore.signer(org.name, purpose as keyof typeof PURPOSE_FILES);
        }
      }
    }

    logger.log(`Loaded the keys of ${organisations.length} organisations and the trust-list signer`);

    return {
      baseUrl,
      issuerUri: (name) => `${baseUrl}/issuers/${name}`,
      keyStore,
      trustedRoots,
      chainValidator: createCertificateChainValidator({ trustedRoots, verifier: webCryptoVerifier, hasher: webCryptoHasher }),
      verifier: webCryptoVerifier,
      hasher: webCryptoHasher,
      random: webCryptoRandom,
      clock
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';

    throw new Error(`Credential keys in IDENTRA_KEYS_DIR are not usable: ${reason}`);
  }
}

/**
 * The trust-list content, re-read when the file's mtime changes. A file that cannot be read or
 * parsed throws (the service then keeps serving its last good token); the error says nothing
 * about the content.
 */
function trustListSource(path: string): () => unknown {
  let cached: { mtimeMs: number; value: unknown } | undefined;

  return () => {
    let mtimeMs: number;

    try {
      mtimeMs = statSync(path).mtimeMs;

      if (cached?.mtimeMs === mtimeMs) return cached.value;

      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));

      cached = { mtimeMs, value };

      return value;
    } catch {
      cached = undefined;
      throw new Error('the trust-list source file is missing or not valid JSON');
    }
  };
}

const LAST_TRUST_LIST_TOKEN = 'last-token';

export const vcProviders: Provider[] = [
  { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
  { provide: ISSUER_CLOCK, useExisting: CLOCK },
  { provide: PKI, inject: [ConfigService, CLOCK], useFactory: loadPki },
  {
    provide: TRUST_LIST_SERVICE,
    inject: [PKI, ConfigService, RedisService],
    useFactory: async (pki: Pki, config: ConfigService, redis: RedisService): Promise<TrustListService> => {
      const trustListLogger = new Logger('TrustList');
      // The last served token survives restarts, so the next iat is always greater (ADR-0019 §4).
      const store = createRedisStateStore(redis.getClient(), 'trust-list');
      const lastToken = await store.get(LAST_TRUST_LIST_TOKEN).catch(() => null);
      const service = createTrustListService({
        source: trustListSource(config.getOrThrow<string>('IDENTRA_TRUST_LIST_SOURCE')),
        keyStore: pki.keyStore,
        clock: pki.clock,
        ...(lastToken ? { lastToken } : {}),
        // The validator's detail can quote the content: log only that it happened.
        onError: () => trustListLogger.warn('Trust-list source refused; still serving the last good token')
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
    provide: STATUS_LIST_SERVICE,
    inject: [PKI, PrismaService],
    // Single-instance assumption (ADR-0016: one VPS, one api container): two processes would
    // still never serve a stale list (token() compares the stored version on every call), but
    // could sign two tokens with one iat in the same second.
    useFactory: (pki: Pki, prisma: PrismaService): StatusListService =>
      createStatusListService({
        issuerUri: pki.issuerUri,
        keyStore: pki.keyStore,
        storage: createPrismaStatusListStorage(prisma),
        random: pki.random,
        clock: pki.clock
      })
  },
  {
    provide: OWN_FETCH,
    inject: [PKI, TRUST_LIST_SERVICE, STATUS_LIST_SERVICE],
    useFactory: (pki: Pki, trustList: TrustListService, statusLists: StatusListService): HttpFetch =>
      createOwnFetch({ baseUrl: pki.baseUrl, trustList, statusLists })
  },
  {
    // For the verifier of the next phase. maxAgeSeconds 0: always re-read (in-process, own origin only).
    provide: TRUST_REGISTRY,
    inject: [PKI, OWN_FETCH],
    useFactory: (pki: Pki, fetch: HttpFetch) =>
      createSignedTrustListRegistry({
        url: `${pki.baseUrl}/trust-list`,
        fetch,
        verifier: pki.verifier,
        chainValidator: pki.chainValidator,
        clock: pki.clock,
        maxAgeSeconds: 0
      })
  },
  {
    provide: STATUS_CHECKER,
    inject: [PKI, OWN_FETCH, TRUST_REGISTRY],
    useFactory: (pki: Pki, fetch: HttpFetch, trustRegistry: ReturnType<typeof createSignedTrustListRegistry>) =>
      createStatusListChecker({
        fetch,
        verifier: pki.verifier,
        chainValidator: pki.chainValidator,
        trustRegistry,
        clock: pki.clock,
        maxAgeSeconds: 0
      })
  }
];
