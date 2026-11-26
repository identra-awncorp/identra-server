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
| `iss` of a DID issuer's credentials (section 4, ADR-0020) | its DID `did:certnet:<network>:<id>`; header `kid` `<did>#key-1` |
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
(issuers of product events), `nha-tuyen-dung-mau` (verifier). With DPKI configured
(section 4) also `truong-mau-certnet`, an issuer of diplomas identified by a DID instead of a
certificate.

## 2. Conventions

- Routes under `/v1` are the application API: JSON, strict validation. Errors
  of the routes in this document are `{ statusCode, code, message }` where
  `code` is a stable upper-case identifier clients branch on (`message` is for
  logs). Codes used here: `INVALID_CREDENTIALS` (401), `SESSION_EXPIRED` (401),
  `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `VALIDATION_FAILED`
  (400, also for malformed JSON), `PAYLOAD_TOO_LARGE` (413), `RATE_LIMITED` (429, with a `Retry-After` header in seconds, exposed to
  browsers through `Access-Control-Expose-Headers`), `INTERNAL_ERROR` (500),
  `UNAVAILABLE` (503, with `Retry-After`). A missing, unknown or expired bearer token is always
  `401 SESSION_EXPIRED`; a valid one without the right to do this is `403 FORBIDDEN`.
- When Postgres or Redis is unreachable, times out or (Redis) refuses writes because it is
  full, a route that needs it answers at once (Redis commands give up after 1 s) with
  `503 UNAVAILABLE` under `/v1`, `503 { "error": "temporarily_unavailable" }` on the protocol
  routes, both with `Retry-After` (5 s for a store that is down); never `500`. What does not need the missing store
  is still served (for example the trust list, and a status list from the token the server holds
  when Postgres is down).
- A path that exists with another method is `404` (`NOT_FOUND` under `/v1`, `not_found` on the
  protocol routes), not `405`.
- A `POST` that creates something answers `201`; a `POST` that changes state
  answers `200`.
- Every response that carries an `expiresAt` also carries `serverTime` (both
  ISO 8601 UTC), so a client counts down against the server's clock, not its own.
- `/v1` routes accept browser calls only from the origins in `CORS_ORIGINS`
  (the website); no cookies are used anywhere, authentication is a bearer token.
- Routes without `/v1` are protocol endpoints whose paths are fixed by a
  specification or signed into credentials. They follow the error format of
  their specification (OAuth 2.0 `{ error, error_description }` for OpenID4VCI
  and OpenID4VP).
- Public signed resources (trust list, status lists, product events, issuer
  metadata, JWKS, offers by reference) send `Access-Control-Allow-Origin: *` and
  `Access-Control-Expose-Headers: Date, Retry-After` on every `GET` answer, errors (`400`,
  `404`, `429`, `503`) included, and never use cookies.
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

A status list is signed at most once per second (its `iat` never repeats). Under rapid
consecutive changes a public read may therefore return the token from just before the latest
change for up to about a second, and while a change is being committed a read waits at most one
second and then gets the last token served. The server's own verifier (section 6) and product
store (section 7) always read the current state. A status list that cannot be signed at the
moment (the issuer's key is unusable) and for which no earlier token is held is `503`.

Changing a credential's status (issuer administrators only):

`POST /v1/issuers/:name/credentials/:credentialId/status` with body
`{ "status": "valid" | "revoked" | "suspended" }` → `200 { id, status, updatedAt }`.
`revoked` is final: a later change is `409`. Authorisation: a portal session
with the registrar role of that issuer (section 5) or the organisation API key.
A change that could not be published (the issuer cannot sign its status lists) is
refused with `503 UNAVAILABLE`, never accepted with `200`; so is a change that keeps
waiting for another one on the same credential (`Retry-After: 1`).

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
| `POST /issuers/:name/nonce` | `c_nonce` (300 s, single use). Unauthenticated (OpenID4VCI 1.0 §7). `429 temporarily_unavailable` with `Retry-After` while this client holds 20 unused nonces, `503 temporarily_unavailable` with `Retry-After` while all clients together hold the global cap (section 8) |
| `POST /issuers/:name/credential` | Proof of possession → `{ credentials: [{ credential }] }`, encrypted when the wallet asks |

Rules:

- QR content: `openid-credential-offer://?credential_offer_uri=<percent-encoded <api>/issuers/<name>/offers/<offerId>>`.
- An offer lives 10 minutes. The pre-authorized code is single use. The
  `tx_code` is 6 digits; after 5 wrong attempts the offer is destroyed. Wrong
  code, wrong PIN, expired or reused → `400 { "error": "invalid_grant" }`.
- `:name` is an OpenID4VCI issuer (`truong-mau`, and `truong-mau-certnet` with DPKI
  configured); every other name, the product issuers included, is `404 not_found`. A hosted
  issuer that cannot sign at the moment answers `503 temporarily_unavailable`.
- One credential per access token. The proof JWT must be
  `typ: openid4vci-proof+jwt`, ES256, header `jwk`, `aud` = issuer identifier,
  `nonce` = an unused `c_nonce`. Its key becomes `cnf.jwk`.
- Credential response encryption (ECDH-ES, A256GCM or A128GCM) is supported and
  the wallet uses it; per OpenID4VCI 1.0 the request is then encrypted too.
- The server stores which student and which status-list entry a credential
  belongs to, and the thumbprint of its `cnf` key. It does not store the
  credential or its disclosures.

### DID issuer `truong-mau-certnet` (DPKI, ADR-0020)

A second sample school that issues the same credential (`bang-tot-nghiep-v1`) on the DID trust
path: it is recognised through CertNet (its DID document and the CertNet trust registry), not
through a certificate and the trust list. It exists only when DPKI is configured
(`CERTNET_GATEWAY_URL` and `CERTNET_NETWORK`, README); without that configuration every route
of it, its status lists included, is `404` and nothing else changes. DPKI is not part of the
production deployment yet.

- Same routes and rules as above with `:name` = `truong-mau-certnet`. Its OpenID4VCI identifier
  (`credential_issuer`, endpoints, `aud`) stays `<api>/issuers/truong-mau-certnet`.
- Its credentials have `iss` = its DID and the header `kid` = `<did>#key-1` (no `x5c`). The
  Credential Issuer metadata has one more member, `identra_issuer_did: "<did>"`; a wallet takes
  a credential of this issuer only when its `iss` is that DID. An X.509 issuer never sends it.
- Its status lists are `<api>/issuers/truong-mau-certnet/status/<n>` (section 3), signed with
  the same DID key (header `kid`, no `x5c`): CertNet holds one key per DID for now.
- Its keys are `orgs/truong-mau-certnet/did.key.pem` and `did.json`, written by
  `npm run certnet:register`, which also registers the DID and its recognition with the gateway
  (README). It is not in the trust list. With DPKI configured but no usable DID key, production
  refuses to start and elsewhere its routes answer `503` (as for every hosted organisation).
- `/v1/health` has `services.dpki: { status, network }` only when DPKI is configured: `up`
  while the DID issuer can sign, `down` otherwise. The gateway is never asked for it.

## 5. School portal demo (`/v1/demo/school`)

A stand-in for a university's own student portal. Accounts are seeded sample
data; nothing here is a real person.

The three student accounts are shared by every visitor (their password is public), so
everything a student creates belongs to the **portal session** that created it, not to the
account: a session is one successful `POST /login`, identified by its `token`. Another session,
even of the same account, does not see, poll, cancel or revoke it (it gets `404`).

| Method and path | Auth | Body | Success | Errors |
|---|---|---|---|---|
| `POST /v1/demo/school/login` | none, rate limited | `{ username, password, issuer? }` | `201 { token, expiresAt, serverTime, role: "student" \| "registrar", issuer, profile }` | `400 VALIDATION_FAILED`, `401 INVALID_CREDENTIALS`, `429 RATE_LIMITED` (also the registrar account from a client with 10 wrong passwords in 15 minutes, or from everyone after 500; section 8), `503 UNAVAILABLE` (also when the server is hashing too many passwords at once; retry after `Retry-After`) |
| `POST /v1/demo/school/offers` | student | none | `201 { offerId, offerUri, txCode, expiresAt, serverTime }` | `403 FORBIDDEN` (registrar), `429 RATE_LIMITED` (this client already holds 5 live offers, or created 100 in the last 30 minutes; an IPv6 /48: 4 times that), `503 UNAVAILABLE` (all clients together hold the cap); both with `Retry-After` |
| `GET /v1/demo/school/offers/:offerId` | student, the session that created it | none | `200 { status: "pending" \| "issued" \| "expired", serverTime }` | `404 NOT_FOUND` (unknown, older than 30 minutes, or another session's) |
| `DELETE /v1/demo/school/offers/:offerId` | student, the session that created it | none | `200 { offerId, status: "expired" \| "issued", serverTime }`: a pending offer is cancelled (its code stops working, its place is freed); an issued one stays issued; repeating it is harmless | `404 NOT_FOUND` as above |
| `GET /v1/demo/school/credentials?limit&cursor` | student or registrar | none | `200 { items: [{ id, studentCode, studentName, issuedAt, status, canRevoke }], nextCursor }`, newest first, `limit` 1–100 (default 50), `nextCursor` `null` on the last page | `400 VALIDATION_FAILED` (limit, cursor) |
| `POST /v1/demo/school/credentials/:credentialId/revoke` | student, the session the credential was issued in | none | `200 { id, status: "revoked", updatedAt }` | `403 FORBIDDEN` (registrar: use section 3), `404 NOT_FOUND` (unknown, another session's or another student's), `409 CONFLICT` (already revoked), `503 UNAVAILABLE` |

Every route but `login` needs `Authorization: Bearer <token>`; a missing, unknown or expired
token is `401 SESSION_EXPIRED`. Writes are rate limited per client (section 8).

- **Login.** The portal token is an opaque bearer token (Redis, 30 minutes; only a hash of it
  is stored). Each account belongs to one issuer and the session acts for that issuer only.
  `issuer` (optional) names the school portal signed in to: an account of another issuer is then
  `401 INVALID_CREDENTIALS`, like an unknown one. Without it the account's own issuer is used,
  as before (`truong-mau` for `sv001`–`sv003` and `phongdaotao`). An account of
  `truong-mau-certnet` cannot sign in while DPKI is off. The `txCode` of an offer is shown once in its creation response and stored only as
  a keyed hash.
- **Offers.** A student session may hold several live offers at once: creating one never ends
  another. An offer's state stays readable for 30 minutes after it was created: `pending` until
  the wallet collects it or 10 minutes pass, then `issued` or `expired`; after 30 minutes the
  route answers `404`. An offer whose code was redeemed but whose credential was never collected
  reads `expired` once the access token (300 s) would have expired. A server restart ends every
  pending offer (the PIN key lives only in memory): the portal reads `expired` and the wallet is
  told the offer expired; the student asks for a new one. Each collected offer is a new
  credential with its own status entry, also when the student already holds a diploma.
- **Credentials listing.** A student session lists only the credentials issued from offers it
  created (others of the same account are not listed); the registrar lists every credential of
  its issuer. `status` is `valid`, `suspended` or `revoked`. `canRevoke` is `true` when the
  session may revoke the item now: for a student every listed item that is not `revoked`, for
  the registrar every item that is not `revoked`; `false` once revoked (revocation is final).
- **Revocation by the student** ("I lost my phone, cancel that copy"): only revocation, only of
  a credential issued in this session, final. Verifiers see it at once through this server and
  within the status list's `ttl` (15 minutes) elsewhere.
- **Registrar.** The registrar changes any diploma's status (`valid`, `suspended`, `revoked`)
  through `POST /v1/issuers/<its issuer>/credentials/:credentialId/status` (section 3) with its
  portal token. A student token there is `403 FORBIDDEN`, and so is another issuer's registrar.
- **One portal per issuer.** Offers, listings and revocations of a session are those of its
  account's issuer only: a session of `truong-mau` never lists, reads or revokes anything of
  `truong-mau-certnet` and the reverse (`404`).
- Every portal answer is `Cache-Control: no-store`.

Seeded sample accounts (fictional people): students `sv001`, `sv002`, `sv003`, whose password
is public (shown on the portal's sign-in page, `Identra@2026` on the demo deployment), and the
registrar `phongdaotao`, whose password is private (at least 20 characters, set by the operator, never published; the
public student password does not open it). `profile` of a student:
`{ hoTen, ngaySinh, maSinhVien, nganh, hangTotNghiep, namTotNghiep, soHieuBang }`
(the university's own record, the source of the diploma's claims); of the
registrar: `{ hoTen, donVi }`.

The login response's `issuer` is the school the session belongs to: `"truong-mau"` or, for the
accounts below, `"truong-mau-certnet"`; clients read it instead of guessing from the username.

With DPKI configured `demo:provision` also creates four accounts for
`truong-mau-certnet` under `cn-` names: students `cn-sv001`, `cn-sv002`, `cn-sv003` (the public
student password) and the registrar `cn-phongdaotao` (its own private password,
`DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET`, never the first registrar's: wrong passwords are counted
per account, so one secret behind both would give twice the guesses and open both schools). Sign
in with `{ "issuer": "truong-mau-certnet", "username": "cn-sv001", "password": "…" }`. The school
has its own records of other fictional people: students Võ Ngọc Khánh Linh, Đặng Minh Khôi and
Bùi Thanh Hà My (student codes `DEMO21CNTT0187`, `DEMO20DTVT0233`, `DEMO22QTKD0091`), the
registrar Ngô Thị Thu Hằng of `Phòng Đào tạo, Trường Mẫu CertNet (DEMO)`, and diploma numbers
(`soHieuBang`) `CNDEMO-2025-000317`, `CNDEMO-2024-001254`, `CNDEMO-2026-000029`, where the first
school's are `TMDEMO-…`.

## 6. Presentation: OpenID4VP 1.0, cross-device

Verifier `nha-tuyen-dung-mau`. The query is fixed on the server per scenario;
a client cannot ask for arbitrary claims.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /v1/verification/sessions` `{ verifier, scenario }` | none, rate limited (section 8) | `201 { id, qr, expiresAt, serverTime }`, `Cache-Control: no-store` (the `id` reads the result); `400 VALIDATION_FAILED` for a malformed body, `404 NOT_FOUND` for an unknown verifier or scenario (neither uses any capacity); `429 RATE_LIMITED` with `Retry-After` while this client holds 10 open sessions or created 100 in the last 30 minutes (an IPv6 /48: 4 times that; a session's place is freed once it is final); `503 UNAVAILABLE` with `Retry-After` while the verifier is not in a valid trust list or all clients together hold the cap |
| `GET /v1/verification/sessions/:id` | knowledge of `id` | Session state and result |
| `GET /oid4vp/request/:requestId` | none | `200 application/oauth-authz-req+jwt` (signed Request Object with `x5c`) |
| `POST /oid4vp/response/:requestId` | none | `direct_post.jwt` body `response=<JWE>` → `200 {}`; a refused response `400 invalid_request`; refused only because the issuer's DID could not be resolved now `503 issuer_registry_unavailable` with `Retry-After` (below) |

- `qr` = `openid4vp://?client_id=<client_id>&request_uri=<api>/oid4vp/request/<requestId>`.
  `id` and `requestId` are independent random values: the QR never reveals the
  value that reads the result.
- A session lives 5 minutes. `nonce` and `state` are single use, but only a response
  that passes the gate checks uses them up. A response refused at a gate check (`structure`,
  `algorithm`, the issuer's certificate chain or, on the DID path, its DID resolution, the issuer
  signature, or holder binding) gets `400 invalid_request` (or the `503` below), leaves the
  session open and counts toward 10 refused responses per request; the 10th ends the session
  `failed` / `TOO_MANY_ATTEMPTS`. The first response that passes them finalises the session, as
  `verified` or `failed` (revoked, untrusted issuer, query not satisfied); every later response
  for that request is `400`.
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
    "trustPath": "x509",
    "issuer": { "maToChuc": "…", "ten": "…" },
    "verifiedAt": "…"
  }
}
```

  `result` is absent (not `null`) until the session is final. `verified` means
  `result.ok` is `true`, `failed` means it is `false`; `claims`, `trustPath` and the issuer
  exist only when `ok`. `trustPath` says how the issuer was recognised: `x509` (a certificate
  in the trust list) with `issuer: { maToChuc, ten }`, or `did` (CertNet, section 4) with
  `issuerDid: "did:certnet:…"` and no `issuer`: the DID path has no display name, so a client
  shows the (shortened) DID and never a name the credential claims for itself. Every claim value is a string (`nam_tot_nghiep` is
  `"2026"`, `ngay_sinh` is `YYYY-MM-DD`). `verifier.name` is the display name
  from the trust list, in Vietnamese.
- A session that nobody answered turns `expired` after 5 minutes and stays
  readable as `expired`; every session is deleted 30 minutes after it was
  created or verified, after which the route answers `404` (clients treat that
  as expired). After the 5 minutes only a small record (about 250 bytes) of an
  unanswered session is kept; the signed request object is gone.
- The server starts without a valid trust list or with its verifier not listed;
  session creation is `503` until a trust list verifies and lists the verifier
  (checked again on every newly signed trust list, otherwise at most every 30 s),
  and `/v1/health` reports `verifier: down` meanwhile. Open sessions stay readable.
- Checks, in order: `structure`, `algorithm`, `certificate_chain`, `signature`,
  `validity_time`, `credential_type`, `issuer_trust`, `status`, `holder_binding`, `query`. On
  the DID path `did_resolution` (the issuer's DID resolved through the CertNet gateway, its key
  in `assertionMethod`) stands where `certificate_chain` is, and `issuer_trust` asks the CertNet
  trust registry for the diploma `vct`.
- The DID path is on only with DPKI configured (section 4). Without it, a credential with a DID
  `kid` fails `did_resolution` with `DID_RESOLUTION_FAILED`. With it: a gateway that gives no
  usable answer (5xx, no answer, timeout, oversized) is `did_resolution` /
  `DID_RESOLUTION_UNAVAILABLE` ("not checked yet"): like every failure of that step the response
  is refused and the session stays open, never verified, but it is answered `503` with
  `Retry-After: 5` and `{ "error": "issuer_registry_unavailable", "error_description": "the
  verifier could not reach its issuer registry; try again shortly" }` instead of `400`, so the
  wallet can say "try again in a moment" and send the same request again (the SDK wallet:
  `DID_RESOLUTION_UNAVAILABLE`). The answer says nothing about the credential or the holder. It
  counts against the session's 10 refused responses like any other (the DID is the sender's
  choice, so an exemption would allow unlimited responses during an outage); the 10th ends the
  session `failed` / `TOO_MANY_ATTEMPTS` with `400`. Other `503`s of this route (Redis or
  Postgres down) stay `temporarily_unavailable`. A trust registry that gives no answer
  is `issuer_trust` / `TRUST_LIST_UNAVAILABLE`, and an issuer the registry does not recognise
  for the diploma (absent, `rejected`, other type) is `issuer_trust` / `ISSUER_NOT_TRUSTED`,
  both final `failed`. Recognition is never cached: a withdrawal counts at the next session.
  Status lists are still read only from this server. The product endpoints (section 7) stay on
  the X.509 path.
- The server verifies against its own status lists directly, so a revocation
  made through this server is seen by the very next verification here. A third
  party that fetches the status list over HTTP may see it up to 15 minutes later
  (the list's `ttl`).

## 7. Product lifecycle

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /v1/products/:gtin/:serial/events` | none | `{ gtin, serial, serverTime, events: ["<compact>", …] }` in chain order; `404` for an unknown product |
| `POST /v1/products/:gtin/:serial/events` `{ credential }` | organisation API key | `201 { seq, id }`: appends one signed event after verifying it and its position in the chain |
| `GET /v1/issuers/:name/credentials?gtin&serial&limit&cursor` | API key of `:name` (a product issuer) | `{ items: [{ id, gtin, serial, seq, congDoan, status, createdAt }], nextCursor }`, that organisation's events, newest first, `limit` ≤ 100 (default 50); `gtin` and `serial` filter |

The server is a store, not an authority: the page that shows a product verifies
every event in the browser with `@identra/sdk-core` and the pinned root
certificate. The `POST` verification only keeps garbage out of the store: the
existing chain must verify completely and the new event must extend it by
exactly the next stage. `serverTime` is a hint for pages to warn about a wrong
device clock; no verification decision uses it.

An event's `id` is what an organisation revokes or suspends it with:
`POST /v1/issuers/:name/credentials/:id/status` (section 3) with its own API key; the
listing finds the ids of earlier events. Refusals of a `POST` carry the SDK's code in
`reason` and the failing position in `index`: `409 CONFLICT` with `CHAIN_BROKEN` when the
event does not extend the product by its next stage (or another one was stored first),
`400 VALIDATION_FAILED` with the verification code otherwise, with
`STATUS_NOT_ALLOCATED` for a status entry this server did not allocate for that issuer,
and `STATUS_ALREADY_USED` for one another event already uses.

`:gtin` is 14 digits with a valid check digit; `:serial` is 1–20 characters of
the GS1 AI (21) character set, percent-encoded in the path. The QR code printed
on a product is exactly `<website>/01/<GTIN-14>/21/<serial>`.

All issuers of this deployment are hosted by this server. When it verifies a
presentation or a product event it reads status lists only from its own
canonical origin, in-process; it never fetches a status list from another host.

## 8. Rate limits and capacity

Per client and per route. A client of the rate limits is the IP address nginx passes on; an
IPv6 /64 counts as one client (GraphQL's cost limiter too). Login 10/min, session creation
30/min, token endpoint 120/min (visitors of a venue share one NAT address; PIN guessing is
bounded by the 5 attempts per offer, section 4), other writes 60/min, reads 300/min (polling a
session once per second and an offer every two seconds stays well inside). The public signed
resources of section 3 and the product events allow 1200/min: verifiers behind one address
fetch them, and they are cacheable. On the routes that create state or cost CPU, an IPv6 **/48**
(65,536 /64s, free from tunnel brokers) also has a budget of **4 clients**: sign-in (portal and
app) 40/min, session creation 120/min, token 480/min, other writes (offers and their cancelling,
nonces, credentials, portal writes, wallet responses, status changes, product events) 240/min.
Reads (session and offer polling, listings, health) and the public resources have no /48 budget:
the phones of one mobile carrier can share a /48 pool, and each polls on its own. IPv4 has no
second level. Exceeding → `429 RATE_LIMITED`
(`temporarily_unavailable` on protocol routes) with `Retry-After`, and the fixed message `Too many
requests; try again later.` GraphQL over its cost budget answers HTTP `429` too
(`extensions.code: RATE_LIMITED`, `Retry-After`). The portal hashes at most two passwords at once;
a sign-in beyond that is `503 UNAVAILABLE` with `Retry-After: 1` (the per-client login limits
apply before any hashing). The registrar account (its name is public) also counts its wrong
passwords **per client**, each count in a window of 15 minutes from its first wrong password:
after 10 from one IPv4 address or IPv6 /56 (40 from one /48), sign-ins to the registrar from that
client answer `429 RATE_LIMITED` with `Retry-After` until its window ends, even with the right
password. An attacker so locks out only itself; the registrar signs in from any other address.
As a backstop the account also counts wrong passwords from everywhere: after 500 within 15
minutes (at least 50 attacking addresses or 13 /48s) every sign-in to the registrar is refused
the same way until that window ends. The operator's fallback meanwhile is the issuer's
organisation API key on the status route (`POST /v1/issuers/truong-mau/credentials/<id>/status`,
section 3), which needs no portal sign-in. The student accounts are never counted, so nobody can
lock them.

Anonymous protocol state lives in Redis (128 MB, `noeviction`: when full, writes fail). Its
cost is bounded by a **global cap** per kind (the memory bound, whatever the number of
addresses), and inside it each client holds at most a fixed **share**, enforced in the same
atomic reservation, so one client (or ten) cannot use up what the others need. A client of the
shares is an IPv4 address or an IPv6 **/56** (256 /64s are one customer at most ISPs); an IPv6
client is counted twice, in its /56 share and in its **/48's share, 4 × the /56 share**, so the
256 /56s of one /48 hold 4 shares, not 256. A request is checked completely (body, verifier,
scenario, session) before it reserves anything; a refused one stores nothing.

| State | Global cap (env, default) | Per IPv4 / IPv6 /56 | Per IPv6 /48 | A place is freed | Redis bytes each | Worst case |
|---|---|---|---|---|---|---|
| Verification session, until final or 5 minutes (signed request object, session key, record) | `VERIFICATION_MAX_LIVE_SESSIONS`, 2000 | 10 | 40 | when a wallet's response makes it final (verified, failed, or 10 refused responses: the result is stored and the request object deleted), or after 5 minutes | ≈ 7.4 KB (measured) | 2000 × 7.4 KB ≈ 15 MB |
| Verification session created in the last 30 minutes (record, retrieved marker, result) | 6 × `VERIFICATION_MAX_LIVE_SESSIONS` = 12 000 | 100 | 400 | after 30 minutes (never earlier: freeing live places early cannot buy more) | ≈ 0.3–1.2 KB (measured) | 12 000 × 1.2 KB ≈ 14 MB |
| `c_nonce` (5 minutes) | `ISSUANCE_MAX_LIVE_NONCES` per issuer, 2000 | 20 | 80 | when a proof uses it, or after 5 minutes | ≈ 0.45 KB (measured) | ≈ 0.9 MB |
| Offer, first 10 minutes (offer, code) | `ISSUANCE_MAX_LIVE_OFFERS` per issuer, 500 | 5 | 20 | when redeemed (token endpoint), cancelled (`DELETE`, five wrong PINs, restart) or after 10 minutes | ≈ 1.4 KB (measured) | ≈ 0.7 MB |
| Offer created in the last 30 minutes (status and portal records) | 20 × `ISSUANCE_MAX_LIVE_OFFERS` = 10 000 | 100 | 400 | after 30 minutes (its status stays readable that long, also once redeemed or cancelled) | ≈ 0.6 KB (status 0.4 + portal owner record 0.18, measured) | ≈ 6 MB |
| Bookkeeping of the caps (sorted sets, owner hash; a session's place id) | one entry per place above, 26 500 | | | with its place | ≈ 0.38 KB per place for IPv4, 0.70 KB for IPv6 (both measured, every client distinct, each IPv6 client its own /48); 0.14 KB per open session | ≤ 26 500 × 0.70 KB + 0.3 MB ≈ 19 MB |
| Portal session (30 minutes; only successful sign-ins) | none: bounded by the sign-in rate, at most two password hashes at once on the api's 0.75 CPU (≈ 30 ms each, measured) ≈ 25 sign-ins/s, so ≤ 45 000 in 30 minutes | (login limits above) | | after 30 minutes | ≈ 0.24 KB (measured) | ≈ 11 MB |

About 67 MB, about half of `maxmemory` and below the 80 % health threshold, with one OpenID4VCI
issuer (`truong-mau`, DPKI off). The three issuance kinds (`c_nonce`, live offers, offers of 30
minutes) and their shares are **per hosted OpenID4VCI issuer**, on purpose: one school's traffic
cannot use up the other's. With DPKI configured there are two (`truong-mau` and
`truong-mau-certnet`), so those caps and a client's shares of them count twice: nonces 2 × 0.9 MB,
live offers 2 × 0.7 MB, offers of 30 minutes 2 × 6 MB, and the bookkeeping 14 000 + 2 × 12 500 =
39 000 places × 0.70 KB + 0.3 MB ≈ 28 MB. The worst case is then 15 + 14 + 1.8 + 1.4 + 12 + 28 + 11
≈ **83 MB**, about 65 % of `maxmemory`, still below the 80 % health threshold (102 MB); the
verification and portal-session kinds are shared by both schools and do not change. Portal sessions are
not capped on purpose: their memory is already bounded by the CPU spent on hashing, and a cap
would let a few hundred addresses (the student password is public) refuse every sign-in for 30
minutes. The global per-minute budget of session creation (`VERIFICATION_SESSIONS_PER_MINUTE`)
is gone: it counted refused requests too, so 300 malformed POSTs from ten addresses blocked every
visitor for a minute; the two session caps bound creations by themselves (at most 12 000 per 30
minutes). Beyond a share (of the /56 or of the /48) the route answers `429` (`RATE_LIMITED` under
`/v1`, `temporarily_unavailable` on the nonce endpoint), beyond a global cap `503` (`UNAVAILABLE`
/ `temporarily_unavailable`), both with `Retry-After` (the seconds until the oldest entry of that
share or cap ends; for the 30-minute kinds up to 30 minutes); sign-in, issuance and everything
else keep their share of Redis. `/v1/health` reports `redis: degraded` above 80 % of `maxmemory`
or when a write is refused (checked every 10 s).

On the DID path (DPKI configured) every `POST /oid4vp/response/:requestId` whose credential names
a DID not in the verifier's resolver cache (60 s; a failure is never cached), an unknown DID
included, costs one request to the CertNet gateway (the DID document,
5 s, 64 KB) before the credential's signature is checked, and the trust-registry lookup one more
once the signature holds: the DID is the sender's choice, so a client can make the server ask the
gateway for DIDs that do not exist. This is a known property, bounded by the existing limits only:
the response route's write limits (60/min per client, 240/min per /48), the 10 refused responses
per session and the session caps above. There is no global cap on concurrent gateway requests; a
gateway that is slow or down makes those responses `503 issuer_registry_unavailable` (section 6)
and nothing else waits on it.

What remains: an attacker with many addresses can still fill a global cap and keep that kind
refused for everyone while the flood lasts (no data is lost, nothing else is affected). With the
shares above it takes, per kind: live verification sessions 200 IPv4 addresses or 50 IPv6 /48s;
sessions of 30 minutes 120 IPv4 addresses or 30 /48s; nonces 100 addresses or 25 /48s; live
offers 100 addresses or 25 /48s (each also needs a portal sign-in); offers of 30 minutes 100
addresses or 25 /48s (or any mix: a /48 counts as four addresses). A tunnel broker hands out
several /48s per free account, so 25 /48s are within one person's reach. The two password-hashing
slots of the portal (about 50 ms each on the VPS) are kept busy, so that other sign-ins answer
`503` and retry, by about 60 /48s at their 40 sign-ins per minute (measured by the reviewer), or
240 IPv4 addresses at 10 per minute. The server cannot tell
such clients from real ones; the remedy is a rate limit at the edge (deploy/README.md, "Edge
rate limits": Cloudflare rules for `POST /issuers/*/nonce`, `POST /v1/verification/sessions`,
`POST /v1/demo/school/login` and `POST /v1/demo/school/offers`).

Visitors behind one NAT address (a class on the school's Wi-Fi) share one client's limits and
shares. For a class of 40 on one IPv4 address: signing in is paced at 10 per minute (the 11th in
a minute waits for `Retry-After`, at most a minute; two hashed at the same instant, a third
retries after a second), so the whole class is in after about 4 minutes; at most **5 diploma
codes wait to be collected at once** for the whole class (the 6th student gets `429` until a
code is redeemed or cancelled; `Retry-After` names the oldest code's 10 minutes, but a place
comes back as soon as a wallet redeems a code, so retrying earlier often works), and 100 codes
in 30 minutes (two or three per student); at most 10 verification sessions open at once, each
freed as soon as its presentation is answered, and 100 sessions in 30 minutes. A class that
does everything in the same minute will see these `429`s; one that works through the steps
over a lesson will not. The same class on IPv6 gets the /56 shares above (and, behind one /48,
at most four times them).
