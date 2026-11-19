import { existsSync, readdirSync, statSync } from 'node:fs';
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
import { isDependencyDown } from '../common/http-errors';
import { HOSTED_ISSUERS, HOSTED_VERIFIERS } from './hosted-issuers';
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
  /**
   * Hosted organisations that cannot sign for one of their purposes (key or certificate missing
   * or invalid), with the failed purposes. Empty in production, which refuses to start instead;
   * elsewhere these organisations' routes answer 503 and health says `down`.
   */
  unavailable: ReadonlyMap<string, string>;
}

const logger = new Logger('Pki');

type Purpose = 'vc' | 'status' | 'request';

/**
 * What every hosted organisation must be able to sign with: issuers `vc` (an OpenID4VCI issuer
 * from `vc.*`, a product issuer from `vc-product.*`) and `status`, verifiers `request`.
 */
const REQUIRED: ReadonlyArray<{ org: string; purposes: Purpose[]; vcFile?: 'vc' | 'vc-product' }> = [
  ...HOSTED_ISSUERS.map((i) => ({ org: i.name, purposes: ['vc', 'status'] as Purpose[], vcFile: i.kind === 'openid4vci' ? ('vc' as const) : ('vc-product' as const) })),
  ...HOSTED_VERIFIERS.map((v) => ({ org: v.name, purposes: ['request'] as Purpose[] }))
];

/**
 * M3: loads every key of every hosted organisation (the key store validates each certificate
 * chain for its profile and that the key matches it). Returns the organisations that cannot sign,
 * each with the failed purposes and the SDK's reason (file names and codes, never key content).
 */
async function checkHostedOrganisations(dir: string, keyStore: IssuerKeyStore): Promise<Map<string, string>> {
  const unavailable = new Map<string, string>();

  for (const { org, purposes, vcFile } of REQUIRED) {
    const failed: string[] = [];

    for (const purpose of purposes) {
      try {
        if (purpose === 'vc' && vcFile && !existsSync(join(dir, 'orgs', org, `${vcFile}.key.pem`))) {
          throw new Error(`a ${vcFile === 'vc' ? 'credential' : 'product'} issuer signs with orgs/${org}/${vcFile}.key.pem, which is missing`);
        }

        await keyStore.signer(org, purpose);
      } catch (error) {
        failed.push(`${purpose}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    if (failed.length > 0) unavailable.set(org, failed.join('; '));
  }

  return unavailable;
}

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
 * Loads the root, the trust-list signer and every key of every hosted organisation at startup.
 * A missing or invalid key of a hosted organisation stops a production start (a server that
 * cannot sign for an organisation it hosts must not pretend); elsewhere it is logged as an error
 * and that organisation is `unavailable`. Messages name organisations, purposes, files and SDK
 * error codes only, never key material.
 */
async function loadPki(config: ConfigService, clock: Clock): Promise<Pki> {
  const dir = config.getOrThrow<string>('IDENTRA_KEYS_DIR');
  const baseUrl = config.getOrThrow<string>('IDENTRA_PUBLIC_BASE_URL');
  const production = config.get<string>('NODE_ENV') === 'production';
  let unavailable: Map<string, string>;
  let keyStore: IssuerKeyStore;
  let trustedRoots: Uint8Array[];

  try {
    refuseCaKeys(dir);

    keyStore = createFileKeyStore(dir);
    trustedRoots = keyStore.trustedRoots();

    await keyStore.trustListSigner();
    unavailable = await checkHostedOrganisations(dir, keyStore);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';

    throw new Error(`Credential keys in IDENTRA_KEYS_DIR are not usable: ${reason}`);
  }

  const problems = [...unavailable].map(([org, reason]) => `${org} (${reason})`);

  if (problems.length > 0 && production) {
    throw new Error(`Credential keys in IDENTRA_KEYS_DIR are not usable for hosted organisations: ${problems.join(', ')}`);
  }

  for (const problem of problems) logger.error(`Hosted organisation cannot sign, its routes answer 503: ${problem}`);

  logger.log(`Loaded the keys of ${REQUIRED.length - unavailable.size} of ${REQUIRED.length} hosted organisations and the trust-list signer`);

  return {
    baseUrl,
    issuerUri: (name) => `${baseUrl}/issuers/${name}`,
    keyStore,
    trustedRoots,
    chainValidator: createCertificateChainValidator({ trustedRoots, verifier: webCryptoVerifier, hasher: webCryptoHasher }),
    verifier: webCryptoVerifier,
    hasher: webCryptoHasher,
    random: webCryptoRandom,
    clock,
    unavailable
  };
}

/** How long a reader of a status list may wait (signing can queue behind a writer's lock). */
export const STATUS_TOKEN_WAIT_MS = 1000;

export const STATUS_PROBLEMS = Symbol('STATUS_PROBLEMS');
export const STATUS_MONITOR = Symbol('STATUS_MONITOR');

export interface StatusMonitor {
  /** `down` after a signing problem in the last hour, or a held token close to expiry. */
  check(): Promise<'up' | 'down'>;
}

interface StatusProblems {
  report(issuer: string, reason: string): void;
  recent(nowMs: number): boolean;
}

function createStatusProblems(): StatusProblems {
  const statusLogger = new Logger('StatusLists');
  const last = new Map<string, number>();

  return {
    report(issuer, reason) {
      const key = `${issuer}:${reason}`;

      // Once a minute per issuer and reason.
      if (Date.now() - (last.get(key) ?? 0) >= 60_000) statusLogger.warn(`Status list of ${issuer} not re-signed (${reason})`);

      last.set(key, Date.now());
    },
    recent: (nowMs) => [...last.values()].some((at) => nowMs - at < 3_600_000)
  };
}

/**
 * Thrown when a status list cannot be served now (503): busy beyond the bound, or not signable
 * (the organisation's status key is unusable, or signing failed), with no earlier token held.
 */
export class StatusListUnavailableError extends Error {}

/**
 * token() re-signs after a change and records the iat on the list row, which waits while a
 * status change holds that row's lock. Readers (the public GET, the own verifier) therefore
 * wait at most STATUS_TOKEN_WAIT_MS and then get the last token this process served for the
 * list: valid, signed, merely without the change that is still being committed. The signing
 * goes on in the background and refreshes the held token. When token() fails (Postgres down,
 * a signing failure) the held token is served too; a signing failure is reported (health `down`).
 */
function withBoundedTokens(service: StatusListService, pki: Pki, problems: StatusProblems): StatusListService {
  const held = new Map<string, string>();

  return {
    ...service,
    async token(issuer, n) {
      if (pki.unavailable.has(issuer)) throw new StatusListUnavailableError('the organisation cannot sign status lists');

      const key = `${issuer}/${n}`;
      const fresh = service.token(issuer, n).then((token) => {
        if (token !== null) held.set(key, token);

        return token;
      });
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), STATUS_TOKEN_WAIT_MS);
      });
      let failure: unknown;

      try {
        const first = await Promise.race([fresh, late]);

        if (first !== 'late') return first;
      } catch (error) {
        failure = error;
        if (!isDependencyDown(error)) problems.report(issuer, 'token_failed');
      } finally {
        clearTimeout(timer);
      }

      fresh.catch(() => undefined);

      const previous = held.get(key);

      if (previous !== undefined) return previous;
      if (failure !== undefined && isDependencyDown(failure)) throw failure;

      throw new StatusListUnavailableError('status list cannot be served now');
    }
  };
}

export const vcProviders: Provider[] = [
  { provide: CLOCK, useValue: { now: () => new Date() } satisfies Clock },
  { provide: ISSUER_CLOCK, useExisting: CLOCK },
  { provide: PKI, inject: [ConfigService, CLOCK], useFactory: loadPki },
  {
    provide: STATUS_LIST_SERVICE,
    inject: [PKI, PrismaService, STATUS_PROBLEMS],
    // Single-instance assumption (ADR-0016: one VPS, one api container): two processes would
    // still never serve a stale list (token() compares the stored version on every call), but
    // could sign two tokens with one iat in the same second.
    useFactory: (pki: Pki, prisma: PrismaService, problems: StatusProblems): StatusListService =>
      withBoundedTokens(
        createStatusListService({
          issuerUri: pki.issuerUri,
          keyStore: pki.keyStore,
          storage: createPrismaStatusListStorage(prisma),
          random: pki.random,
          clock: pki.clock,
          // The held token is served meanwhile; the reason (never content) goes to the log and health.
          onError: (reason, issuer) => problems.report(issuer, reason)
        }),
        pki,
        problems
      )
  },
  { provide: STATUS_PROBLEMS, useFactory: createStatusProblems },
  {
    provide: STATUS_MONITOR,
    inject: [STATUS_LIST_SERVICE, STATUS_PROBLEMS, PrismaService, PKI],
    useFactory: (statusLists: StatusListService, problems: StatusProblems, prisma: PrismaService, pki: Pki): StatusMonitor => ({
      async check() {
        const nowS = pki.clock.now().getTime() / 1000;

        // An issuer that cannot sign its lists, or a signing problem in the last hour.
        if (HOSTED_ISSUERS.some((i) => pki.unavailable.has(i.name))) return 'down';
        if (problems.recent(pki.clock.now().getTime())) return 'down';

        const lists = await prisma.vcStatusList.findMany({ select: { issuerName: true, listNumber: true } });

        for (const { issuerName, listNumber } of lists) {
          const held = statusLists.current(issuerName, listNumber);

          // Not signed yet by this process is fine; a held token must live 2 h more by a valid signer.
          if (held && (held.exp <= nowS + 2 * 3600 || held.signerNotAfter <= nowS)) return 'down';
        }

        return 'up';
      }
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
