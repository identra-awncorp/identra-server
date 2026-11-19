import { createHash } from 'node:crypto';

import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { base64Decode, base64UrlEncode, VCT, type Clock, type DiplomaClaims, type TrustRegistry } from '@identra/sdk-core';
import {
  CREDENTIAL_CONFIGURATIONS,
  createCredentialIssuer,
  generateIssuerKeys,
  NONCE_SECONDS,
  OFFER_SECONDS,
  OFFER_STATUS_SECONDS,
  type CredentialHandlers,
  type CredentialIssuer,
  type StatusListService
} from '@identra/sdk-server';

import { createLiveCaps, LiveCaps, Reservation } from '../common/live-cap';
import { createRedisStateStore, StateStore } from '../common/state-store';
import { StudentProfile } from '../demo-portal/demo-accounts';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { OPENID4VCI_ISSUERS } from './hosted-issuers';
import { VcCredentialsService } from './vc-credentials.service';
import { ISSUER_CLOCK, PKI, Pki, STATUS_LIST_SERVICE, TRUST_REGISTRY } from './vc.providers';

export const ISSUERS = Symbol('ISSUERS');
/** The protocol state of every hosted issuer (the SDK prefixes its keys with the issuer URI). */
export const ISSUER_STATE_NAMESPACE = 'vci';
/** The school portal's own offer state: `owner:<offerId>` = the creating portal session's hash. */
export const PORTAL_OFFER_NAMESPACE = 'portal-offer';
export const offerOwnerKey = (offerId: string) => `owner:${offerId}`;

/** Shares of one client (an IPv4 address or IPv6 /56) inside the global caps (docs/vc-api.md §8). */
export const NONCES_PER_CLIENT = 20;
export const OFFERS_PER_CLIENT = 5;
/** Offers created in the last 30 minutes (their status stays readable that long): per client, and globally per live offer. */
export const OFFER_RECORDS_PER_CLIENT = 30;
export const OFFER_RECORDS_PER_LIVE_OFFER = 10;

export const capKinds = (name: string) => ({
  /** Live offers (10 minutes, until redeemed or cancelled), ISSUANCE_MAX_LIVE_OFFERS; ended at the next start. */
  offers: `vci-offers:${name}`,
  /** Offers whose status is still readable (30 minutes): bounds the records left by ended offers. */
  offerRecords: `vci-offer-records:${name}`,
  /** Live c_nonces (5 minutes, until used; anonymous), ISSUANCE_MAX_LIVE_NONCES. */
  nonces: `vci-nonces:${name}`
});

export interface HostedIssuer {
  name: string;
  issuerUri: string;
  issuer: CredentialIssuer;
  caps: LiveCaps;
  /**
   * Counts the c_nonce the SDK has just stored against `client`'s share and the global cap; when
   * refused, the nonce is removed again. Its place is freed when a proof uses it, or after 5 minutes.
   */
  reserveNonce(cNonce: string, client: string): Promise<Reservation>;
  /** The same for a new offer (live and 30-minute caps); a refused offer leaves nothing in Redis. */
  reserveOffer(offerId: string, client: string): Promise<Reservation>;
}

/**
 * The SDK's key layout (sdk-server issuance/issuer.ts, `key()` and `hashedKey()`), known only here:
 * secret values (a c_nonce) appear as base64url(SHA-256). The live-cap test fails when it changes.
 */
const sdkKey = (issuerUri: string, kind: 'nonce' | 'offer' | 'status', id: string) => `vci:${issuerUri}:${kind}:${id}`;
const SDK_TAKEN = /^(nonce|offer):([A-Za-z0-9_-]+)$/;
export const nonceId = (cNonce: string) => createHash('sha256').update(cNonce, 'utf8').digest('base64url');

/**
 * The SDK's store, plus: a nonce or offer record taken (atomically, so by exactly one caller) gives
 * its place back. That covers a nonce used by a proof, an offer redeemed at the token endpoint, and
 * an offer ended (cancelled, five wrong PINs, a restart). Expiry is handled by the caps' scores.
 */
function releasingOnTake(store: StateStore, issuerUri: string, release: (kind: 'nonce' | 'offer', id: string) => Promise<void>): StateStore {
  const prefix = `vci:${issuerUri}:`;

  return {
    ...store,
    async take(key) {
      const value = await store.take(key);
      const taken = value !== null && key.startsWith(prefix) ? SDK_TAKEN.exec(key.slice(prefix.length)) : null;

      // Best effort: a place not given back ends with its lifetime.
      if (taken) await release(taken[1] as 'nonce' | 'offer', taken[2]!).catch(() => undefined);

      return value;
    }
  };
}

export type IssuerRegistry = ReadonlyMap<string, HostedIssuer>;

type HandlerFactory = (
  issuerName: string,
  deps: { prisma: PrismaService; credentials: VcCredentialsService; portalState: StateStore }
) => CredentialHandlers;

/** The diploma's seven claims come from the school portal's own record of the student. */
const diplomaFromPortal: HandlerFactory = (issuerName, { prisma, credentials, portalState }) => ({
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
  // The portal session that created the offer (null if its record is gone): it lists and may revoke the credential.
  onIssued: async (event) => {
    const portalSessionHash = await portalState.get(offerOwnerKey(event.offerId)).catch(() => null);

    return credentials.recordIssued({ issuerName, vct: VCT.diploma, ...event, portalSessionHash });
  }
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
    const kind = capKinds(hosted.name).offers;
    const ids = await hosted.caps.live(kind);

    for (const id of ids) await hosted.issuer.cancelOffer(id);

    await hosted.caps.clear(kind);
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
      const portalState = createRedisStateStore(redis.getClient(), PORTAL_OFFER_NAMESPACE);
      const caps = createLiveCaps(redis.getClient(), clock);
      const maxOffers = config.getOrThrow<number>('ISSUANCE_MAX_LIVE_OFFERS');
      const maxNonces = config.getOrThrow<number>('ISSUANCE_MAX_LIVE_NONCES');
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
        const kinds = capKinds(hosted.name);
        const issuerStore = releasingOnTake(store, issuerUri, (kind, id) => caps.release(kind === 'nonce' ? kinds.nonces : kinds.offers, id));
        const issuer = createCredentialIssuer({
          issuerUri,
          display: hosted.display,
          signer,
          allocateStatus: () => statusLists.allocate(hosted.name),
          hasher: pki.hasher,
          verifier: pki.verifier,
          random: pki.random,
          clock,
          store: issuerStore,
          keys: await generateIssuerKeys(pki.random),
          credentials: Object.fromEntries(
            hosted.credentials.map((id) => [id, HANDLERS[id]!(hosted.name, { prisma, credentials, portalState })])
          )
        });

        const entry: HostedIssuer = {
          name: hosted.name,
          issuerUri,
          issuer,
          caps,
          async reserveNonce(cNonce, client) {
            const id = nonceId(cNonce);
            const slot = await caps.reserve(kinds.nonces, id, NONCE_SECONDS, { cap: maxNonces, perClient: { key: client, cap: NONCES_PER_CLIENT } });

            if (!slot.ok) await store.take(sdkKey(issuerUri, 'nonce', id));

            return slot;
          },
          async reserveOffer(offerId, client) {
            const records = await caps.reserve(kinds.offerRecords, offerId, OFFER_STATUS_SECONDS, {
              cap: maxOffers * OFFER_RECORDS_PER_LIVE_OFFER,
              perClient: { key: client, cap: OFFER_RECORDS_PER_CLIENT }
            });
            const live = records.ok
              ? await caps.reserve(kinds.offers, offerId, OFFER_SECONDS, { cap: maxOffers, perClient: { key: client, cap: OFFERS_PER_CLIENT } })
              : records;

            if (live.ok) return live;
            if (records.ok) await caps.release(kinds.offerRecords, offerId);

            // Its status record first, so that ending the offer writes no `ended` flag either.
            await store.take(sdkKey(issuerUri, 'status', offerId));
            await issuer.cancelOffer(offerId);

            return live;
          }
        };

        await endPreviousOffers(entry);
        registry.set(hosted.name, entry);
      }

      return registry;
    }
  }
];
