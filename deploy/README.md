# Deploying identra-server on the VPS

Layout and decisions: ADR-0016. Stack: `docker-compose.prod.yml` (api, Postgres, Redis),
secrets in `/etc/identra/server.env`, signing keys in `/etc/identra/keys`.

## nginx

`nginx/api-identra.conf.example` is the server block for `api-identra.awncorp.vn`. On the
VPS all hostnames live in `/etc/nginx/sites-available/awncorp.conf`: replace the existing
`api-identra.awncorp.vn` block there with this one (same `listen 127.0.0.1:80`, same
`proxy_pass http://127.0.0.1:4000`), then `sudo nginx -t && sudo systemctl reload nginx`.

It matters for security, not just logging: the server trusts exactly one proxy hop and
takes the client IP (used for rate limits and stored on sessions) from the last
`X-Forwarded-For` entry. The block sets that header to the address from
`CF-Connecting-IP`, overwriting whatever the client sent. Without it every request seems
to come from 127.0.0.1 and all visitors share one rate-limit budget.

## Keys (`/etc/identra/keys`, mounted read-only at `/run/identra/keys`)

Layout of `identra-sdk/scripts/pki/README.md`: `root.cert.pem`, `orgs/<name>/<purpose>.key.pem`
+ `.chain.pem`, `trust-list-signer/trust-list.{key,cert}.pem`, and the trust-list content
`trust-list.source.json`. Never the `ca/` directory: the Root and Issuing CA keys do not
touch the VPS (ADR-0015 §2). The container runs as uid 1000, and the SDK refuses a key file
that is not a regular file of mode 600, so: `sudo chown -R 1000:1000 /etc/identra/keys`,
`chmod 600` every `*.key.pem`, `chmod 700` the directories. The server loads the key of every
purpose of every hosted organisation at startup (`src/vc/hosted-issuers.ts`) and, in production,
refuses to start when one is missing or does not validate, naming the organisation, the purpose
and the file (never key content). Outside production it starts, logs the problem as an error and
answers `503` on that organisation's routes; `/v1/health` then shows `statusLists: down` or
`verifier: down`.

Editing `trust-list.source.json` takes effect on the next request (re-read when its mtime
changes). An invalid edit keeps the last good list in service, logs a warning, and
`/v1/health` keeps `trustList: up` until that list expires (24 h): check the log after
every edit.

The school portal's sample accounts (idempotent; run again to reset their password):

```bash
docker compose --env-file /etc/identra/server.env -f docker-compose.prod.yml \
  run --rm -e DEMO_PORTAL_PASSWORD='Identra@2026' api npm run demo:provision
```

### Credential issuer (OpenID4VCI, `truong-mau`)

- Its `vc` key and certificate are `orgs/truong-mau/vc.{key,chain}.pem` in the key directory;
  the certificate's SAN must be `https://api-identra.awncorp.vn/issuers/truong-mau`. The
  issuers are listed in `src/vc/hosted-issuers.ts` (a second one is one entry plus its keys).
- The access-token signing key, the request-encryption key and the HMAC key of the PIN hashes
  are generated in memory at every start and never stored. **A restart invalidates outstanding
  access tokens (at most 5 minutes old), the encryption key a wallet read just before, and ends
  every pending offer** (offers live 10 minutes; their ids are kept in Redis for this): the
  portal shows the offer as expired, the wallet says it expired, and the student asks for a new
  one. Offer state lives in Redis (readable
  30 minutes) and keeps only a keyed hash of the PIN, so Redis alone never reveals a PIN.
- `demo:provision` creates or updates only the four `DemoPortalAccount` rows (`sv001`–`sv003`,
  `phongdaotao`), whose profiles are the claims of the diplomas issued; it touches no other
  table and never prints the password. Issued diplomas are recorded in `VcIssuedCredential`
  (status entry, cnf thumbprint, no claims); the credential itself is never stored.

### Product issuers (`nha-san-xuat`, `kiem-dinh`, `phan-phoi`)

- Each signs its lifecycle events with `orgs/<name>/vc-product.{key,chain}.pem` (the key store
  serves it as purpose `vc`) and has its own status lists (`orgs/<name>/status.*`). They have no
  OpenID4VCI endpoints. Organisations post events with their API key
  (`IDENTRA_ORG_API_KEY_HASHES`) and revoke one through
  `POST /v1/issuers/<name>/credentials/<event id>/status`.
- The compact events are stored in `ProductEvent` (public by design, ADR-0012 §2); the page
  verifies them itself. An event's status entry must have been allocated by this server.
- The sample product (GTIN 09520123456788, GS1 demo prefix 952; not a real product):

```bash
docker compose --env-file /etc/identra/server.env -f docker-compose.prod.yml \
  run --rm -e DEMO_PRODUCT_PROVISION=yes api npm run demo:provision-product
# a second product with two stages, for the "not yet distributed" state of the page
docker compose ... run --rm -e DEMO_PRODUCT_PROVISION=yes -e DEMO_PRODUCT_SERIAL=SN-2026-000002 \
  -e DEMO_PRODUCT_STAGES=2 api npm run demo:provision-product
```

  It signs in-process with the three organisations' keys, stores each event through the same
  check as the API, skips stages already stored (a second run changes nothing) and touches only
  `ProductEvent` and the status-list tables.

### Verifier (OpenID4VP, `nha-tuyen-dung-mau`)

- Its `request` key is `orgs/nha-tuyen-dung-mau/request.{key,chain}.pem`; the certificate's
  fingerprint must be in the trust list with purpose `request`. Without a valid trust list, or
  while the list does not have it, the server still starts: session creation answers `503`,
  `/v1/health` shows `verifier: down` and the log says `Verifier nha-tuyen-dung-mau cannot create
  sessions: …`. It is checked again on every newly signed trust list (an edit takes effect on
  the next request) and otherwise at most every 30 s. Verifiers are listed in
  `src/vc/hosted-issuers.ts`.
- Sessions and their results live only in Redis (5 minutes to answer, results 30 minutes).
  Nothing about a presentation is written to Postgres or to the log, which carries only the
  first 8 characters of the session id, the outcome and the failing check code.

The key directory must not contain CA keys: the server refuses to start when it finds a `ca/`
directory or a `ca.key.pem` anywhere under it (ADR-0015 §2, ADR-0016 §6).

Single instance: one api container (ADR-0016). Status lists are read from Postgres on every
request, so a second instance would never serve a stale list, but two instances could sign
two tokens with the same `iat` in one second.

## Deploy

```bash
cd /srv/awncorp/identra-api/identra-server
git pull
export IDENTRA_IMAGE_TAG=$(git rev-parse --short HEAD)
docker compose --env-file /etc/identra/server.env -f docker-compose.prod.yml up -d --build
docker compose --env-file /etc/identra/server.env -f docker-compose.prod.yml ps
```

Each deploy keeps its image as `identra-prod-api:<sha>`. On start the api container runs
`prisma migrate deploy`, then the server.

## Rolling back an image

```bash
docker images identra-prod-api          # pick the previous tag
IDENTRA_IMAGE_TAG=<previous-sha> docker compose --env-file /etc/identra/server.env \
  -f docker-compose.prod.yml up -d --no-build api
```

Migrations only go forward. An older image runs against the newer schema, which works
only while migrations are additive (new nullable columns, new tables). A release that
drops or renames something needs a restore from the nightly backup instead (ADR-0016 §4).

## A migration failed (api restarting, `P3009`)

Symptom: `docker compose ... logs api` shows `Error: P3009 migrate found failed migrations
in the target database` and the api container restarts in a loop (`restart: unless-stopped`).
Prisma refuses to continue until the failed migration is resolved.

1. Stop the loop: `docker compose ... stop api`.
2. Find the failed migration and its error. Open a shell with
   `docker compose ... exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` and run
   `select migration_name, logs from "_prisma_migrations" where finished_at is null;`
3. Look at what it already changed (Postgres runs each migration file in one transaction
   unless it contains statements that cannot, so usually nothing). Undo any partial change
   by hand.
4. Mark it rolled back so it is retried on the next start:
   `docker compose ... run --rm api npx prisma migrate resolve --rolled-back <migration_name>`
   (or `--applied <migration_name>` if you completed it by hand).
5. Fix the migration in the repository if it was wrong, deploy, or roll back the image as
   above. If the data is damaged, restore the nightly backup first.

## Redis memory

Redis runs with `--maxmemory 128mb --maxmemory-policy noeviction`: nothing is evicted
silently. When full, writes fail; `/v1/auth/*` then answers 503 (rate limiting fails
closed) and other REST routes run without rate limits; routes that must write answer 503.
The anonymous protocol state (verification sessions, c_nonces, offers) is capped across all
clients at about 28 MB in the worst case (docs/vc-api.md §8; `VERIFICATION_MAX_LIVE_SESSIONS`,
`VERIFICATION_SESSIONS_PER_MINUTE`, `ISSUANCE_MAX_LIVE_NONCES`, `ISSUANCE_MAX_LIVE_OFFERS`).
`/v1/health` reports `redis: degraded` (and `status: degraded`) above 80 % of `maxmemory` or
when a write is refused. Check with `docker compose ... exec redis redis-cli info memory`.
