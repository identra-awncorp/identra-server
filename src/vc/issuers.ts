import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { base64Decode, base64UrlEncode, VCT, type Clock, type DiplomaClaims, type TrustRegistry } from '@identra/sdk-core';
import {
  CREDENTIAL_CONFIGURATIONS,
  createCredentialIssuer,
  generateIssuerKeys,
  NONCE_SECONDS,
  OFFER_SECONDS,
  type CredentialHandlers,
  type CredentialIssuer,
  type StatusListService
} from '@identra/sdk-server';

import { createLiveCap, LiveCap } from '../common/live-cap';
import { createRedisStateStore } from '../common/state-store';
import { StudentProfile } from '../demo-portal/demo-accounts';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { OPENID4VCI_ISSUERS } from './hosted-issuers';
import { VcCredentialsService } from './vc-credentials.service';
import { ISSUER_CLOCK, PKI, Pki, STATUS_LIST_SERVICE, TRUST_REGISTRY } from './vc.providers';

export const ISSUERS = Symbol('ISSUERS');
/** The protocol state of every hosted issuer (the SDK prefixes its keys with the issuer URI). */
export const ISSUER_STATE_NAMESPACE = 'vci';

export interface HostedIssuer {
  name: string;
  issuerUri: string;
  issuer: CredentialIssuer;
  /** Live offers (10 minutes each), capped (ISSUANCE_MAX_LIVE_OFFERS); ended at the next start. */
  offers: LiveCap;
  /** Live c_nonces (5 minutes each; anonymous), capped (ISSUANCE_MAX_LIVE_NONCES). */
  nonces: LiveCap;
}

export type IssuerRegistry = ReadonlyMap<string, HostedIssuer>;

type HandlerFactory = (issuerName: string, deps: { prisma: PrismaService; credentials: VcCredentialsService }) => CredentialHandlers;

/** The diploma's seven claims come from the school portal's own record of the student. */
const diplomaFromPortal: HandlerFactory = (issuerName, { prisma, credentials }) => ({
  async resolveClaims(subjectRef): Promise<DiplomaClaims | null> {
    const account = await prisma.demoPortalAccount.findUnique({ where: { username: subjectRef } });

    if (!account || account.role !== 'student' || account.issuerName !== issuerName) return null;

    const p = account.profile as Partial<Record<keyof StudentProfile, unknown>>;
    const claims = {
      ho_ten: p.hoTen,
      ngay_sinh: p.ngaySinh,
      ma_sinh_vien: p.maSinhVien,
      nganh: p.nganh,
      hang_tot_nghiep: p.hangTotNghiep,
      nam_tot_nghiep: p.namTotNghiep,
      so_hieu_bang: p.soHieuBang
    };

    return Object.values(claims).every((v) => typeof v === 'string' && v !== '') ? (claims as DiplomaClaims) : null;
  },
  onIssued: (event) => credentials.recordIssued({ issuerName, vct: VCT.diploma, ...event })
});

const HANDLERS: Record<string, HandlerFactory> = { 'bang-tot-nghiep-v1': diplomaFromPortal };
const logger = new Logger('Issuers');

/**
 * N3: the trust list must list an OpenID4VCI issuer's `vc` certificate with purpose `vc` and the
 * types it issues. A definite mismatch is a refusal; no trust list yet or no entry is only logged
 * (the list can be fixed while the server runs, M1).
 */
async function trustListRefusal(pki: Pki, trustRegistry: TrustRegistry, name: string, x5c: string[], vcts: string[]): Promise<string | null> {
  const fingerprint = base64UrlEncode(await pki.hasher.sha256(base64Decode(x5c[0]!)));
  const entry = await trustRegistry.lookup(fingerprint, pki.clock.now()).catch(() => undefined);

  if (entry === undefined) logger.warn(`Issuer ${name}: no trust list to check its vc certificate against yet`);
  else if (entry === null) logger.warn(`Issuer ${name}: its vc certificate is not in the trust list; its credentials will not verify`);
  else if (entry.mucDich !== 'vc' || !vcts.every((vct) => entry.vct?.includes(vct))) {
    return `its vc certificate is in the trust list with purpose ${entry.mucDich} and other credential types`;
  }

  return null;
}

/**
 * L1: the PIN key lives only in memory, so the offers of a previous process can never be redeemed.
 * End them (the portal reads `expired`, the wallet gets "offer expired") instead of letting the
 * wallet burn PIN attempts on them. Best effort: with Redis down the start goes on.
 */
async function endPreviousOffers(hosted: HostedIssuer): Promise<void> {
  try {
    const ids = await hosted.offers.live();

    for (const id of ids) await hosted.issuer.cancelOffer(id);

    await hosted.offers.clear();
    if (ids.length > 0) logger.log(`Issuer ${hosted.name}: ended ${ids.length} offers of the previous process`);
  } catch {
    logger.warn(`Issuer ${hosted.name}: could not end the offers of the previous process (Redis)`);
  }
}

export const issuerProviders: Provider[] = [
  {
    provide: ISSUERS,
    inject: [PKI, ISSUER_CLOCK, STATUS_LIST_SERVICE, RedisService, PrismaService, VcCredentialsService, TRUST_REGISTRY, ConfigService],
    // The access-token, request-encryption and PIN keys are generated here, in memory: a restart
    // invalidates outstanding access tokens (at most 300 s old) and ends every pending offer.
    // An issuer that cannot sign (pki.unavailable) or whose trust-list entry does not fit is not
    // hosted: production refuses to start, elsewhere its routes answer 503.
    useFactory: async (
      pki: Pki,
      clock: Clock,
      statusLists: StatusListService,
      redis: RedisService,
      prisma: PrismaService,
      credentials: VcCredentialsService,
      trustRegistry: TrustRegistry,
      config: ConfigService
    ): Promise<IssuerRegistry> => {
      const store = createRedisStateStore(redis.getClient(), ISSUER_STATE_NAMESPACE);
      const registry = new Map<string, HostedIssuer>();

      for (const hosted of OPENID4VCI_ISSUERS) {
        if (pki.unavailable.has(hosted.name)) continue;

        const signer = await pki.keyStore.signer(hosted.name, 'vc');
        const vcts = hosted.credentials.map((id) => CREDENTIAL_CONFIGURATIONS[id]!.vct);
        const refusal = await trustListRefusal(pki, trustRegistry, hosted.name, signer.x5c!, vcts);

        if (refusal !== null) {
          if (config.get<string>('NODE_ENV') === 'production') throw new Error(`Issuer ${hosted.name} cannot start: ${refusal}`);

          logger.error(`Issuer ${hosted.name} is not hosted, its routes answer 503: ${refusal}`);
          continue;
        }

        const issuerUri = pki.issuerUri(hosted.name);
        const issuer = createCredentialIssuer({
          issuerUri,
          display: hosted.display,
          signer,
          allocateStatus: () => statusLists.allocate(hosted.name),
          hasher: pki.hasher,
          verifier: pki.verifier,
          random: pki.random,
          clock,
          store,
          keys: await generateIssuerKeys(pki.random),
          credentials: Object.fromEntries(
            hosted.credentials.map((id) => [id, HANDLERS[id]!(hosted.name, { prisma, credentials })])
          )
        });

        const cap = (kind: string, max: string, lifetimeSeconds: number) =>
          createLiveCap(redis.getClient(), `vci-${kind}:${hosted.name}`, { max: config.getOrThrow<number>(max), lifetimeSeconds, clock });
        const entry: HostedIssuer = {
          name: hosted.name,
          issuerUri,
          issuer,
          offers: cap('offers', 'ISSUANCE_MAX_LIVE_OFFERS', OFFER_SECONDS),
          nonces: cap('nonces', 'ISSUANCE_MAX_LIVE_NONCES', NONCE_SECONDS)
        };

        await endPreviousOffers(entry);
        registry.set(hosted.name, entry);
      }

      return registry;
    }
  }
];
