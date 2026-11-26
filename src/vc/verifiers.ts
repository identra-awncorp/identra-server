import { Logger, Provider } from '@nestjs/common';
import { VCT, type Clock, type StatusChecker } from '@identra/sdk-core';
import { createPresentationVerifier, type PresentationVerifier, type TrustListService } from '@identra/sdk-server';

import { createRedisStateStore } from '../common/state-store';
import { RedisService } from '../infrastructure/redis/redis.service';
import { HOSTED_VERIFIERS } from './hosted-issuers';
import { DPKI, Dpki, PKI, Pki, STATUS_CHECKER, TRUST_LIST_SERVICE, TRUST_REGISTRY } from './vc.providers';
import type { createSignedTrustListRegistry } from '@identra/sdk-core';

type Registry = ReturnType<typeof createSignedTrustListRegistry>;

export const VERIFIERS = Symbol('VERIFIERS');
/** The verifiers' clock (session lifetimes, KB-JWT time checks); a separate token for tests. */
export const VERIFIER_CLOCK = Symbol('VERIFIER_CLOCK');
export const VERIFIER_STATE_NAMESPACE = 'vp';
export const VERIFIER_MONITOR = Symbol('VERIFIER_MONITOR');

/** At most this often a verifier that could not be built is tried again (a new trust list: at once). */
export const VERIFIER_RETRY_MS = 30_000;

export interface VerifierMonitor {
  /** `down` while a hosted verifier cannot create sessions (not built, or no longer listed). */
  check(): Promise<'up' | 'down'>;
}

/**
 * The OpenID4VP verifiers this server hosts (HOSTED_VERIFIERS), in a degraded state when they
 * cannot be built: the server boots without a usable trust list (M1), session creation answers
 * 503 until a trust list verifies and lists the verifier, health says `verifier: down`.
 */
export interface HostedVerifiers extends VerifierMonitor {
  /**
   * The verifier that may create sessions now, or null: unknown name, its `request` key unusable,
   * no trust list, or its certificate not listed with purpose `request`. The SDK verifier looks
   * itself up in the trust list when it is built, so it is built again for every new trust-list
   * token (L2: an edit that drops it is seen on the next call), and a failed build is retried at
   * most every VERIFIER_RETRY_MS.
   */
  available(name: string): Promise<PresentationVerifier | null>;
  /**
   * Every verifier built so far, also one no longer listed: requests, responses and results of
   * its open sessions stay readable (their state lives in Redis, keyed by client_id).
   */
  built(): PresentationVerifier[];
  /** The SDK's own hourly re-check answered `verifier_not_listed`. */
  notListed(name: string): void;
}

const logger = new Logger('Verifiers');

interface Slot {
  /** The last verifier built; kept for open sessions when it is no longer listed. */
  verifier: PresentationVerifier | null;
  /** May create sessions: built against `token` and listed in it. */
  listed: boolean;
  token: string | null;
  triedAt: number;
  building?: Promise<void>;
}

export function createHostedVerifiers(deps: {
  pki: Pki;
  clock: Clock;
  trustList: TrustListService;
  trustRegistry: Registry;
  statusChecker: StatusChecker;
  /** With DPKI configured the verifiers also accept DID issuers' credentials (ADR-0020). */
  dpki?: Dpki | null;
  redis: RedisService;
}): HostedVerifiers {
  const { pki, clock, trustList, trustRegistry, dpki } = deps;
  const statusChecker = dpki?.statusChecker ?? deps.statusChecker;
  const didPath = dpki ? { dpki: { resolver: dpki.resolver, trustRegistry: dpki.trustRegistry } } : {};
  const store = createRedisStateStore(deps.redis.getClient(), VERIFIER_STATE_NAMESPACE);
  const slots = new Map<string, Slot>(HOSTED_VERIFIERS.map((h) => [h.name, { verifier: null, listed: false, token: null, triedAt: -Infinity }]));

  async function build(name: string, slot: Slot, token: string | null): Promise<void> {
    const hosted = HOSTED_VERIFIERS.find((h) => h.name === name)!;
    const wasListed = slot.listed;

    slot.triedAt = Date.now();
    slot.token = token;

    try {
      if (token === null) throw new Error('no valid trust list is available');

      slot.verifier = await createPresentationVerifier({
        apiOrigin: pki.baseUrl,
        signer: await pki.keyStore.signer(name, 'request'),
        verification: {
          verifier: pki.verifier,
          hasher: pki.hasher,
          chainValidator: pki.chainValidator,
          trustRegistry,
          statusChecker,
          supportedVcts: [VCT.diploma],
          ...didPath
        },
        random: pki.random,
        clock,
        store,
        scenarios: hosted.scenarios
      });
      slot.listed = true;
      if (!wasListed) logger.log(`Verifier ${name} is ready`);
    } catch (error) {
      slot.listed = false;
      // The SDK's reason names a check or code, never key material.
      if (wasListed || slot.verifier === null) logger.warn(`Verifier ${name} cannot create sessions: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  async function available(name: string): Promise<PresentationVerifier | null> {
    const slot = slots.get(name);

    if (!slot || pki.unavailable.has(name)) return null;

    // Reading the token re-signs the trust list when its source changed (cheap otherwise).
    const token = await trustList.token().catch(() => null);
    const stale = token !== slot.token || (!slot.listed && Date.now() - slot.triedAt >= VERIFIER_RETRY_MS);

    if (stale) {
      slot.building ??= build(name, slot, token).finally(() => (slot.building = undefined));
      await slot.building;
    }

    return slot.listed ? slot.verifier : null;
  }

  return {
    available,
    built: () => [...slots.values()].flatMap((slot) => (slot.verifier ? [slot.verifier] : [])),
    notListed(name) {
      const slot = slots.get(name);

      if (slot?.listed) {
        logger.warn(`Verifier ${name} is no longer in the trust list`);
        Object.assign(slot, { listed: false, triedAt: Date.now() });
      }
    },
    async check() {
      const states = await Promise.all([...slots.keys()].map(async (name) => (await available(name)) !== null));

      return states.every(Boolean) ? 'up' : 'down';
    }
  };
}

export const verifierProviders: Provider[] = [
  {
    provide: VERIFIERS,
    inject: [PKI, VERIFIER_CLOCK, TRUST_LIST_SERVICE, TRUST_REGISTRY, STATUS_CHECKER, DPKI, RedisService],
    // Tried once at startup; a verifier that cannot be built does not stop the server (M1).
    useFactory: async (
      pki: Pki,
      clock: Clock,
      trustList: TrustListService,
      trustRegistry: Registry,
      statusChecker: StatusChecker,
      dpki: Dpki | null,
      redis: RedisService
    ) => {
      const verifiers = createHostedVerifiers({ pki, clock, trustList, trustRegistry, statusChecker, dpki, redis });

      await verifiers.check();

      return verifiers;
    }
  },
  { provide: VERIFIER_MONITOR, useExisting: VERIFIERS }
];
