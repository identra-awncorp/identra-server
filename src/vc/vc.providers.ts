import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../infrastructure/prisma/prisma.service';
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
 * ADR-0015 §2, ADR-0016 §6: the Root and Issuing CA keys never live on the server. A `ca/`
 * directory or a `ca.key.pem` anywhere under the key directory stops the startup (the
 * message names the path, never content). Follows symlinks, a few levels deep.
 */
export function refuseCaKeys(dir: string, depth = 0): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);

    if ((name === 'ca' && st.isDirectory()) || name === 'ca.key.pem') {
      throw new Error(`${path} looks like CA key material; Root and Issuing CA keys must not be on the server (ADR-0015 §2)`);
    }

    if (st.isDirectory() && depth < 4) refuseCaKeys(path, depth + 1);
  }
}

/**
 * Loads every key of the store (each organisation's keys found on disk and the trust-list
 * signer), so a missing, unreadable or invalid key stops the startup instead of the first
 * request. Messages name files and SDK error codes only, never key material.
 */
async function loadPki(config: ConfigService, clock: Clock): Promise<Pki> {
  const dir = config.getOrThrow<string>('IDENTRA_KEYS_DIR');
  const baseUrl = config.getOrThrow<string>('IDENTRA_PUBLIC_BASE_URL');

  try {
    refuseCaKeys(dir);

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

/** How long a reader of a status list may wait (signing can queue behind a writer's lock). */
export const STATUS_TOKEN_WAIT_MS = 1000;

/** Thrown when a status list cannot be served within the bound and no earlier token is held. */
export class StatusListBusyError extends Error {}

/**
 * token() re-signs after a change and records the iat on the list row, which waits while a
 * status change holds that row's lock. Readers (the public GET, the own verifier) therefore
 * wait at most STATUS_TOKEN_WAIT_MS and then get the last token this process served for the
 * list: valid, signed, merely without the change that is still being committed. The signing
 * goes on in the background and refreshes the held token.
 */
function withBoundedTokens(service: StatusListService): StatusListService {
  const held = new Map<string, string>();

  return {
    ...service,
    async token(issuer, n) {
      const key = `${issuer}/${n}`;
      const fresh = service.token(issuer, n).then((token) => {
        if (token !== null) held.set(key, token);

        return token;
      });
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), STATUS_TOKEN_WAIT_MS);
      });

      try {
        const first = await Promise.race([fresh, late]);

        if (first !== 'late') return first;
      } finally {
        clearTimeout(timer);
      }

      fresh.catch(() => undefined);

      const previous = held.get(key);

      if (previous === undefined) throw new StatusListBusyError('status list is busy');

      return previous;
    }
  };
}

export const vcProviders: Provider[] = [
  { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
  { provide: ISSUER_CLOCK, useExisting: CLOCK },
  { provide: PKI, inject: [ConfigService, CLOCK], useFactory: loadPki },
  {
    provide: STATUS_LIST_SERVICE,
    inject: [PKI, PrismaService],
    // Single-instance assumption (ADR-0016: one VPS, one api container): two processes would
    // still never serve a stale list (token() compares the stored version on every call), but
    // could sign two tokens with one iat in the same second.
    useFactory: (pki: Pki, prisma: PrismaService): StatusListService =>
      withBoundedTokens(
        createStatusListService({
          issuerUri: pki.issuerUri,
          keyStore: pki.keyStore,
          storage: createPrismaStatusListStorage(prisma),
          random: pki.random,
          clock: pki.clock
        })
      )
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
