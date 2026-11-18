import { Logger, Provider } from '@nestjs/common';
import { VCT, type Clock, type StatusChecker } from '@identra/sdk-core';
import { createPresentationVerifier, type PresentationVerifier, type Scenario } from '@identra/sdk-server';

import { createRedisStateStore } from '../common/state-store';
import { RedisService } from '../infrastructure/redis/redis.service';
import { PKI, Pki, STATUS_CHECKER, TRUST_REGISTRY } from './vc.providers';
import type { createSignedTrustListRegistry } from '@identra/sdk-core';

type Registry = ReturnType<typeof createSignedTrustListRegistry>;

/**
 * The OpenID4VP verifiers this server hosts (docs/vc-api.md §6). A second verifier is one more
 * entry here plus its `request` key in IDENTRA_KEYS_DIR and its fingerprint in the trust list.
 * The query of each scenario is fixed here: a client cannot ask for other claims.
 */
export const HOSTED_VERIFIERS: ReadonlyArray<{ name: string; scenarios: Record<string, Scenario> }> = [
  {
    name: 'nha-tuyen-dung-mau',
    scenarios: {
      'ung-tuyen': {
        vct: VCT.diploma,
        claimSets: [
          ['ho_ten', 'nganh', 'hang_tot_nghiep', 'nam_tot_nghiep'],
          ['ho_ten', 'nganh']
        ],
        purpose: {
          vi: 'Ứng tuyển vị trí kỹ sư phần mềm tại Nhà Tuyển Dụng Mẫu (DEMO)',
          en: 'Job application: software engineer at the Sample Employer (DEMO)'
        }
      }
    }
  }
];

export const VERIFIERS = Symbol('VERIFIERS');
/** The verifiers' clock (session lifetimes, KB-JWT time checks); a separate token for tests. */
export const VERIFIER_CLOCK = Symbol('VERIFIER_CLOCK');
export const VERIFIER_STATE_NAMESPACE = 'vp';
export const VERIFIER_MONITOR = Symbol('VERIFIER_MONITOR');

export type VerifierRegistry = ReadonlyMap<string, PresentationVerifier>;

export interface VerifierMonitor {
  /** `down` when a hosted verifier's certificate is no longer in the trust list (re-checked hourly). */
  check(): Promise<'up' | 'down'>;
}

const logger = new Logger('Verifiers');

export const verifierProviders: Provider[] = [
  {
    provide: VERIFIERS,
    inject: [PKI, VERIFIER_CLOCK, TRUST_REGISTRY, STATUS_CHECKER, RedisService],
    // Built at startup: the SDK validates the request certificate and looks it up in the trust
    // list (purpose `request`); a verifier that is not trusted stops the server from starting.
    useFactory: async (pki: Pki, clock: Clock, trustRegistry: Registry, statusChecker: StatusChecker, redis: RedisService) => {
      const store = createRedisStateStore(redis.getClient(), VERIFIER_STATE_NAMESPACE);
      const registry = new Map<string, PresentationVerifier>();

      for (const hosted of HOSTED_VERIFIERS) {
        try {
          registry.set(
            hosted.name,
            await createPresentationVerifier({
              apiOrigin: pki.baseUrl,
              signer: await pki.keyStore.signer(hosted.name, 'request'),
              verification: {
                verifier: pki.verifier,
                hasher: pki.hasher,
                chainValidator: pki.chainValidator,
                trustRegistry,
                statusChecker,
                supportedVcts: [VCT.diploma]
              },
              random: pki.random,
              clock,
              store,
              scenarios: hosted.scenarios
            })
          );
        } catch (error) {
          throw new Error(`Verifier ${hosted.name} cannot start: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }

      return registry as VerifierRegistry;
    }
  },
  {
    provide: VERIFIER_MONITOR,
    inject: [VERIFIERS, TRUST_REGISTRY, PKI],
    useFactory: (verifiers: VerifierRegistry, trustRegistry: Registry, pki: Pki): VerifierMonitor => {
      let verdict: { state: 'up' | 'down'; at: number } | undefined;

      return {
        async check() {
          const now = pki.clock.now().getTime();

          if (verdict && now - verdict.at < 3_600_000 && now >= verdict.at) return verdict.state;

          let state: 'up' | 'down' = 'up';

          for (const [name, verifier] of verifiers) {
            const entry = await trustRegistry.lookup(verifier.clientId.slice('x509_hash:'.length)).catch(() => null);

            if (entry?.mucDich !== 'request') {
              state = 'down';
              logger.warn(`Verifier ${name} is no longer in the trust list`);
            }
          }

          verdict = { state, at: now };

          return state;
        }
      };
    }
  }
];
