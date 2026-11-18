import { Provider } from '@nestjs/common';
import { VCT, type Clock, type DiplomaClaims } from '@identra/sdk-core';
import {
  createCredentialIssuer,
  generateIssuerKeys,
  type CredentialHandlers,
  type CredentialIssuer,
  type StatusListService
} from '@identra/sdk-server';

import { createRedisStateStore } from '../common/state-store';
import { StudentProfile } from '../demo-portal/demo-accounts';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { VcCredentialsService } from './vc-credentials.service';
import { ISSUER_CLOCK, PKI, Pki, STATUS_LIST_SERVICE } from './vc.providers';

/**
 * The OpenID4VCI issuers this server hosts. A second issuer is one more entry here (and its
 * `vc` key in IDENTRA_KEYS_DIR); `credentials` names configurations of the SDK's
 * CREDENTIAL_CONFIGURATIONS whose handlers are built below.
 */
export const HOSTED_ISSUERS = [
  {
    name: 'truong-mau',
    display: { vi: 'Trường Mẫu (DEMO)', en: 'Sample University (DEMO)' },
    credentials: ['bang-tot-nghiep-v1']
  }
] as const satisfies ReadonlyArray<{ name: string; display: { vi: string; en: string }; credentials: readonly string[] }>;

export const ISSUERS = Symbol('ISSUERS');
/** The protocol state of every hosted issuer (the SDK prefixes its keys with the issuer URI). */
export const ISSUER_STATE_NAMESPACE = 'vci';

export interface HostedIssuer {
  name: string;
  issuerUri: string;
  issuer: CredentialIssuer;
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

export const issuerProviders: Provider[] = [
  {
    provide: ISSUERS,
    inject: [PKI, ISSUER_CLOCK, STATUS_LIST_SERVICE, RedisService, PrismaService, VcCredentialsService],
    // The access-token and request-encryption keys are generated here, in memory: a restart
    // invalidates outstanding access tokens (at most 300 s old); the wallet scans a new offer.
    useFactory: async (
      pki: Pki,
      clock: Clock,
      statusLists: StatusListService,
      redis: RedisService,
      prisma: PrismaService,
      credentials: VcCredentialsService
    ): Promise<IssuerRegistry> => {
      const store = createRedisStateStore(redis.getClient(), ISSUER_STATE_NAMESPACE);
      const registry = new Map<string, HostedIssuer>();

      for (const hosted of HOSTED_ISSUERS) {
        const issuerUri = pki.issuerUri(hosted.name);
        const issuer = createCredentialIssuer({
          issuerUri,
          display: hosted.display,
          signer: await pki.keyStore.signer(hosted.name, 'vc'),
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

        registry.set(hosted.name, { name: hosted.name, issuerUri, issuer });
      }

      return registry;
    }
  }
];
