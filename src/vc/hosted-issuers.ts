/**
 * The issuers this server hosts. `openid4vci`: issues to wallets (docs/vc-api.md §4; its handlers
 * in issuers.ts). `product`: signs product lifecycle events (§7); no OpenID4VCI endpoints, its
 * events are stored in ProductEvent. Every hosted issuer has its own status lists (§3). A new
 * issuer is one entry here plus its keys in IDENTRA_KEYS_DIR and its trust-list entry.
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
