# Verifiable-credential HTTP API

Contract between `identra-server` and its callers: the wallet (`@identra/sdk-app`),
the website (`@identra/sdk-client`, the school portal demo, the product page) and
any third party that verifies on its own. Protocol logic lives in
`@identra/sdk-server`; controllers only do HTTP, storage and call the SDK.

Decisions behind this file: the ADRs 0007–0017 in the private parent repository.

## 1. Origins and identifiers

| Thing | Value |
|---|---|
| Canonical API origin | `https://api-identra.awncorp.vn` (env `IDENTRA_PUBLIC_BASE_URL`) |
| Website origin | `https://identra.awncorp.vn` |
| Credential Issuer identifier, also `iss` of its credentials | `<api>/issuers/<name>` |
| Status list | `<api>/issuers/<name>/status/<n>` |
| Trust list | `<api>/trust-list` |
| Verifier `client_id` | `x509_hash:<base64url(SHA-256(leaf certificate DER))>` |
| Product QR (GS1 Digital Link) | `<website>/01/<GTIN>/21/<serial>` |

Identifiers are signed into credentials and never change with the environment.
A development or test deployment keeps the canonical identifiers and only
redirects network access: the server answers requests for its own canonical
URLs in-process, and clients are configured with the address that stands in for
the canonical origin (`fetch` mapping in the SDK). Nothing in a verification
path accepts a non-canonical or non-HTTPS identifier.

Sample organisations (all operated by Identra, certificates carry "DEMO"):
`truong-mau` (issuer of diplomas), `nha-san-xuat`, `kiem-dinh`, `phan-phoi`
(issuers of product events), `nha-tuyen-dung-mau` (verifier).

## 2. Conventions

- Routes under `/v1` are the application API: JSON, strict validation, errors
  as `{ statusCode, error, message, code? }`.
- Routes without `/v1` are protocol endpoints whose paths are fixed by a
  specification or signed into credentials. They follow the error format of
  their specification (OAuth 2.0 `{ error, error_description }` for OpenID4VCI
  and OpenID4VP).
- Public signed resources (trust list, status lists, product events, issuer
  metadata) send `Access-Control-Allow-Origin: *` and never use cookies.
- Nothing logs claims, credentials, disclosures, KB-JWTs, PINs, pre-authorized
  codes or tokens. Logs carry identifiers, error codes and timings only.
- Every identifier handed to a client is at least 128 bits from a CSPRNG.
- Short-lived state lives in Redis with a TTL; durable state in Postgres.

## 3. Trust list and status lists (unprefixed, public)

| Method and path | Response |
|---|---|
| `GET /trust-list` | `200 application/jwt`: `identra-trust-list+jwt`, `Cache-Control: public, max-age=300` |
| `GET /issuers/:name/status/:n` | `200 application/statuslist+jwt`, `Cache-Control: public, max-age=60`; `404` for an unknown list |

Both are re-signed hourly and on every change. Cache lifetimes stay well below
the `ttl` inside the tokens (3600 s and 900 s) so a revocation is never delayed
by an intermediary longer than the token allows.

Changing a credential's status (issuer administrators only):

`POST /v1/issuers/:name/credentials/:credentialId/status` with body
`{ "status": "valid" | "revoked" | "suspended" }` → `200 { id, status, updatedAt }`.
`revoked` is final: a later change is `409`. Authorisation: a portal session
with the registrar role of that issuer (section 5) or the organisation API key.

## 4. Issuance: OpenID4VCI 1.0, pre-authorized code (unprefixed)

Issuer `truong-mau`, credential configuration `bang-tot-nghiep-v1`
(`dc+sd-jwt`, `vct` `https://identra.awncorp.vn/vct/bang-tot-nghiep/v1`,
proof type `jwt` with ES256).

| Method and path | Purpose |
|---|---|
| `GET /.well-known/openid-credential-issuer/issuers/:name` | Credential Issuer metadata |
| `GET /.well-known/oauth-authorization-server/issuers/:name` | Authorization Server metadata |
| `GET /issuers/:name/jwks` | Keys that sign access tokens |
| `GET /issuers/:name/offers/:offerId` | Credential Offer by reference; `404` once expired or used |
| `POST /issuers/:name/token` | Pre-authorized code + `tx_code` → access token (300 s) |
| `POST /issuers/:name/nonce` | `c_nonce` (300 s, single use) |
| `POST /issuers/:name/credential` | Proof of possession → `{ credentials: [{ credential }] }`, encrypted when the wallet asks |

Rules:

- QR content: `openid-credential-offer://?credential_offer_uri=<api>/issuers/<name>/offers/<offerId>`.
- An offer lives 10 minutes. The pre-authorized code is single use. The
  `tx_code` is 6 digits; after 5 wrong attempts the offer is destroyed. Wrong
  code, wrong PIN, expired or reused → `400 { "error": "invalid_grant" }`.
- One credential per access token. The proof JWT must be
  `typ: openid4vci-proof+jwt`, ES256, header `jwk`, `aud` = issuer identifier,
  `nonce` = an unused `c_nonce`. Its key becomes `cnf.jwk`.
- Credential response encryption (ECDH-ES, A256GCM or A128GCM) is supported and
  the wallet uses it; per OpenID4VCI 1.0 the request is then encrypted too.
- The server stores which student and which status-list entry a credential
  belongs to, and the thumbprint of its `cnf` key. It does not store the
  credential or its disclosures.

## 5. School portal demo (`/v1/demo/school`)

A stand-in for a university's own student portal. Accounts are seeded sample
data; nothing here is a real person.

| Method and path | Auth | Response |
|---|---|---|
| `POST /v1/demo/school/login` `{ username, password }` | none, rate limited | `{ token, expiresAt, role: "student" \| "registrar", profile }` |
| `POST /v1/demo/school/offers` | student | `{ offerId, offerUri, txCode, expiresAt }` |
| `GET /v1/demo/school/offers/:offerId` | student (owner) | `{ status: "pending" \| "issued" \| "expired" }` |
| `GET /v1/demo/school/credentials` | student: own; registrar: all | `{ items: [{ id, studentCode, studentName, issuedAt, status }] }` |

The portal token is an opaque bearer token (Redis, 30 minutes). The `txCode`
is shown once in the response and stored only as a keyed hash.

Seeded sample accounts (fictional people, public on purpose, shown on the
portal's sign-in page): students `sv001`, `sv002`, `sv003` and registrar
`phongdaotao`, all with the password `Identra@2026`. `profile` of a student:
`{ hoTen, ngaySinh, maSinhVien, nganh, hangTotNghiep, namTotNghiep, soHieuBang }`
(the university's own record, the source of the diploma's claims); of the
registrar: `{ hoTen, donVi }`. The registrar changes a diploma's status through
`POST /v1/issuers/truong-mau/credentials/:credentialId/status` (section 3) with
the portal token.

## 6. Presentation: OpenID4VP 1.0, cross-device

Verifier `nha-tuyen-dung-mau`. The query is fixed on the server per scenario;
a client cannot ask for arbitrary claims.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /v1/verification/sessions` `{ verifier, scenario }` | none, rate limited | `{ id, qr, expiresAt }` |
| `GET /v1/verification/sessions/:id` | knowledge of `id` | Session state and result |
| `GET /oid4vp/request/:requestId` | none | `200 application/oauth-authz-req+jwt` (signed Request Object with `x5c`) |
| `POST /oid4vp/response/:requestId` | none | `direct_post.jwt` body `response=<JWE>` → `200 {}` |

- `qr` = `openid4vp://?client_id=<client_id>&request_uri=<api>/oid4vp/request/<requestId>`.
  `id` and `requestId` are independent random values: the QR never reveals the
  value that reads the result.
- A session lives 5 minutes. `nonce` and `state` are single use: the first
  response for a request is processed, every later one is `400`.
- Scenario `ung-tuyen`: DCQL for one `dc+sd-jwt` credential of the diploma
  `vct`; `claim_sets` option 1 = `ho_ten`, `nganh`, `hang_tot_nghiep`,
  `nam_tot_nghiep`; option 2 = `ho_ten`, `nganh`.
- Session resource:

```json
{
  "id": "…",
  "status": "pending | request_retrieved | verified | failed | expired",
  "verifier": { "name": "…" },
  "expiresAt": "…",
  "result": {
    "ok": true,
    "checks": [{ "id": "structure", "ok": true, "code": null }],
    "claims": { "ho_ten": "…", "nganh": "…" },
    "issuer": { "maToChuc": "…", "ten": "…" },
    "verifiedAt": "…"
  }
}
```

  `result` exists for `verified` and `failed`; `claims` only when `ok`. The
  result is deleted 30 minutes after verification.

## 7. Product lifecycle

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /v1/products/:gtin/:serial/events` | none | `{ gtin, serial, events: ["<compact>", …] }` in chain order; `404` for an unknown product |
| `POST /v1/products/:gtin/:serial/events` `{ credential }` | organisation API key | Appends one signed event after verifying it and its position in the chain |

The server is a store, not an authority: the page that shows a product verifies
every event in the browser with `@identra/sdk-core` and the pinned root
certificate. The `POST` verification only keeps garbage out of the store.

## 8. Rate limits

Per client IP (the address nginx passes on): login 10/min, session creation
30/min, token endpoint 20/min, other writes 60/min. Exceeding → `429`.
