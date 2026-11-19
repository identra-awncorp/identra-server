import { VCT } from '@identra/sdk-core';
import type { Scenario } from '@identra/sdk-server';

/**
 * The issuers this server hosts (the verifiers are at the end). `openid4vci`: issues to wallets
 * (docs/vc-api.md §4; its handlers in issuers.ts; its key is `vc.*`). `product`: signs product
 * lifecycle events (§7; its key is `vc-product.*`); no OpenID4VCI endpoints, its events are stored
 * in ProductEvent. Every hosted issuer has its own status lists (§3). A new issuer is one entry
 * here plus its keys in IDENTRA_KEYS_DIR and its trust-list entry. Every key of every hosted
 * organisation is checked at start-up (vc.providers.ts): production refuses to start without one,
 * elsewhere that organisation's routes answer 503.
 */
export const HOSTED_ISSUERS = [
  {
    name: 'truong-mau',
    kind: 'openid4vci',
    display: { vi: 'Trường Mẫu (DEMO)', en: 'Sample University (DEMO)' },
    credentials: ['bang-tot-nghiep-v1']
  },
  { name: 'nha-san-xuat', kind: 'product' },
  { name: 'kiem-dinh', kind: 'product' },
  { name: 'phan-phoi', kind: 'product' }
] as const;

export type HostedIssuerKind = (typeof HOSTED_ISSUERS)[number]['kind'];

export function issuerKind(name: string): HostedIssuerKind | null {
  return HOSTED_ISSUERS.find((issuer) => issuer.name === name)?.kind ?? null;
}

export const OPENID4VCI_ISSUERS = HOSTED_ISSUERS.filter(
  (issuer): issuer is Extract<(typeof HOSTED_ISSUERS)[number], { kind: 'openid4vci' }> => issuer.kind === 'openid4vci'
);
export const PRODUCT_ISSUERS: readonly string[] = HOSTED_ISSUERS.filter((issuer) => issuer.kind === 'product').map((i) => i.name);

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
