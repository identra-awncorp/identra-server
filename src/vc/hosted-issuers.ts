import { VCT } from '@identra/sdk-core';
import type { Scenario } from '@identra/sdk-server';

/**
 * The issuers this server hosts (the verifiers are at the end). `openid4vci`: issues to wallets
 * (docs/vc-api.md §4; its handlers in issuers.ts). `product`: signs product lifecycle events (§7;
 * its key is `vc-product.*`); no OpenID4VCI endpoints, its events are stored in ProductEvent.
 * `identification`: how verifiers recognise the issuer (ADR-0020, one path per issuer). `x509`: its
 * key is `vc.*` / `vc-product.*` with a certificate, its lists are signed by `status.*`, and it has a
 * trust-list entry. `did`: its key is `did.key.pem` + `did.json` (a `did:certnet` DID, made by
 * `npm run certnet:register`), which also signs its lists; it exists only when DPKI is configured
 * (CERTNET_GATEWAY_URL and CERTNET_NETWORK) and is never in the trust list. Every hosted issuer has
 * its own status lists (§3). Every key of every hosted organisation is checked at start-up
 * (vc.providers.ts): production refuses to start without one, elsewhere that organisation's routes
 * answer 503.
 */
export const HOSTED_ISSUERS = [
  {
    name: 'truong-mau',
    kind: 'openid4vci',
    identification: 'x509',
    display: { vi: 'Trường Mẫu (DEMO)', en: 'Sample University (DEMO)' },
    credentials: ['bang-tot-nghiep-v1']
  },
  {
    name: 'truong-mau-certnet',
    kind: 'openid4vci',
    identification: 'did',
    display: { vi: 'Trường Mẫu CertNet (DEMO)', en: 'Sample University on CertNet (DEMO)' },
    credentials: ['bang-tot-nghiep-v1']
  },
  { name: 'nha-san-xuat', kind: 'product', identification: 'x509' },
  { name: 'kiem-dinh', kind: 'product', identification: 'x509' },
  { name: 'phan-phoi', kind: 'product', identification: 'x509' }
] as const;

export type HostedIssuerEntry = (typeof HOSTED_ISSUERS)[number];
export type OpenId4VciIssuer = Extract<HostedIssuerEntry, { kind: 'openid4vci' }>;

/** The issuers hosted in this configuration: those identified by a DID only when DPKI is configured. */
export const hostedIssuers = (dpki: boolean): readonly HostedIssuerEntry[] =>
  HOSTED_ISSUERS.filter((issuer) => dpki || issuer.identification !== 'did');

export const isOpenId4Vci = (issuer: HostedIssuerEntry): issuer is OpenId4VciIssuer => issuer.kind === 'openid4vci';
export const isDidIssuer = (name: string) => HOSTED_ISSUERS.some((issuer) => issuer.name === name && issuer.identification === 'did');
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
