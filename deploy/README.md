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
touch the VPS (ADR-0015 §2). The container runs as the dedicated uid/gid **10001** (no account
of that number exists on the host; never 1000, usually the first human account of an Ubuntu
image), and the SDK refuses a key file that is not a regular file of mode 600:

```bash
sudo chown -R 10001:10001 /etc/identra/keys
sudo find /etc/identra/keys -type d -exec chmod 700 {} +
sudo find /etc/identra/keys -type f -name '*.key.pem' -exec chmod 600 {} +
sudo find /etc/identra/keys -type f ! -name '*.key.pem' -exec chmod 644 {} +   # certificates, trust-list source
```

The server loads the key of every
purpose of every hosted organisation at startup (`src/vc/hosted-issuers.ts`) and, in production,
refuses to start when one is missing or does not validate, naming the organisation, the purpose
and the file (never key content). Outside production it starts, logs the problem as an error and
answers `503` on that organisation's routes; `/v1/health` then shows `statusLists: down` or
`verifier: down`.

Editing `trust-list.source.json` takes effect on the next request (re-read when its mtime
changes). An invalid edit keeps the last good list in service, logs a warning, and
`/v1/health` keeps `trustList: up` until that list expires (24 h): check the log after
every edit.

The school portal's sample accounts: Deploy, step 7.

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
  table and never prints a password. It needs two: `DEMO_PORTAL_PASSWORD` for the three students
  (public, printed on the portal's sign-in page) and `DEMO_PORTAL_REGISTRAR_PASSWORD` for the
  registrar (private, at least 20 characters, different: the registrar can suspend and revoke
  every diploma, and its account name is public). Never publish the second one. Wrong registrar
  passwords are counted per client: 10 in 15 minutes from one address (40 from one IPv6 /48)
  lock the registrar's sign-in from that address only, so the registrar signs in from another.
  After 500 in 15 minutes from everywhere (a distributed attack) the registrar's sign-in is
  refused for everyone until those 15 minutes end; meanwhile change statuses with the
  organisation API key of `truong-mau` (`IDENTRA_ORG_API_KEY_HASHES`), typed so it stays out of
  the shell history and the process list:
  `read -rs KEY; printf 'Authorization: Bearer %s' "$KEY" | curl -H @- -H 'content-type: application/json' -d '{"status":"revoked"}' https://api-identra.awncorp.vn/v1/issuers/truong-mau/credentials/<id>/status; unset KEY`.
  The student accounts are never locked.
- Every visitor of a student account works in their own portal session: offers, the diplomas
  issued from them and their revocation belong to that session (docs/vc-api.md §5). Issued diplomas are recorded in `VcIssuedCredential`
  (status entry, cnf thumbprint, no claims); the credential itself is never stored.

### Product issuers (`nha-san-xuat`, `kiem-dinh`, `phan-phoi`)

- Each signs its lifecycle events with `orgs/<name>/vc-product.{key,chain}.pem` (the key store
  serves it as purpose `vc`) and has its own status lists (`orgs/<name>/status.*`). They have no
  OpenID4VCI endpoints. Organisations post events with their API key
  (`IDENTRA_ORG_API_KEY_HASHES`) and revoke one through
  `POST /v1/issuers/<name>/credentials/<event id>/status`.
- The compact events are stored in `ProductEvent` (public by design, ADR-0012 §2); the page
  verifies them itself. An event's status entry must have been allocated by this server.
- The sample product (GTIN 09520123456788, GS1 demo prefix 952; not a real product): Deploy,
  step 7.

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

The VPS has Docker and nothing else: no Node, no npm, no git needed. The image is built ON the
VPS from two source trees that the admin machine sends there, exported from pinned commits; the
image records both commits (labels, and `build` in `GET /v1` and `/v1/health`).

Layout (owned by the admin account, `755` directories: the build context must be writable by
the admin only, since whatever is in it can end up in the image):

```text
/srv/awncorp/identra-api/
  identra-sdk/      the SDK at its pinned commit (sources only)
  identra-server/   this repository at its pinned commit
  REVISIONS         IDENTRA_SERVER_REVISION=<sha>, IDENTRA_SDK_REVISION=<sha>
/etc/identra/server.env   secrets (the admin account's, mode 600; template .env.production.example)
/etc/identra/keys/        signing keys (10001:10001, see "Keys")
```

1. **On the admin machine**, pick the commits (both trees clean, both pushed) and export exactly
   those commits, nothing else (no `node_modules`, `dist/`, `.pki/`, `.env*`, untracked files):

   ```bash
   SERVER=$(git -C identra-server rev-parse HEAD); SDK=$(git -C identra-sdk rev-parse HEAD)
   for t in identra-server identra-sdk; do test -z "$(git -C $t status --porcelain)" || echo "$t is dirty"; done
   ssh vps 'set -e; cd /srv/awncorp/identra-api; rm -rf identra-sdk.new identra-server.new; mkdir identra-sdk.new identra-server.new'
   git -C identra-sdk archive --format=tar "$SDK" | ssh vps 'tar -x -C /srv/awncorp/identra-api/identra-sdk.new'
   git -C identra-server archive --format=tar "$SERVER" | ssh vps 'tar -x -C /srv/awncorp/identra-api/identra-server.new'
   ssh vps "set -e; cd /srv/awncorp/identra-api
     rm -rf identra-sdk.old identra-server.old
     [ -d identra-sdk ] && mv identra-sdk identra-sdk.old; [ -d identra-server ] && mv identra-server identra-server.old
     mv identra-sdk.new identra-sdk; mv identra-server.new identra-server
     printf 'IDENTRA_SERVER_REVISION=%s\nIDENTRA_SDK_REVISION=%s\n' $SERVER $SDK > REVISIONS"
   ```

   (A git checkout on the VPS works as well: `git -C … checkout --detach <sha>` in both trees,
   then the same `REVISIONS` file; `git archive` needs no git and no credentials there.)
2. **On the VPS**, build (several minutes: the SDK and the server are compiled inside the image):

   ```bash
   cd /srv/awncorp/identra-api && . ./REVISIONS
   export IDENTRA_IMAGE_TAG=$(printf %.7s "$IDENTRA_SERVER_REVISION")
   docker build -f identra-server/Dockerfile --target prod \
     --build-arg IDENTRA_SERVER_REVISION="$IDENTRA_SERVER_REVISION" \
     --build-arg IDENTRA_SDK_REVISION="$IDENTRA_SDK_REVISION" \
     -t identra-prod-api:"$IDENTRA_IMAGE_TAG" .
   docker image inspect identra-prod-api:"$IDENTRA_IMAGE_TAG" --format '{{json .Config.Labels}}'
   ```

3. First time only: `/etc/identra/server.env` from `.env.production.example`
   (`sudo install -m 600 -o "$USER" -g "$USER" identra-server/.env.production.example /etc/identra/server.env`,
   then fill it in), the keys as in "Keys", nginx as in "nginx".
4. Start (or update) the stack. Compose never builds or pulls the api image; it runs the tag:

   ```bash
   cd /srv/awncorp/identra-api/identra-server
   export IDENTRA_IMAGE_TAG    # from step 2
   C="docker compose --env-file /etc/identra/server.env -f docker-compose.prod.yml"
   $C up -d
   ```

   The api container applies the committed migrations (`prisma migrate deploy`, the CLI inside
   the image: no npm, no network) and then starts the server. The first boot creates the schema.
5. Wait for health: `$C ps` shows `api` as `healthy` (the healthcheck reads `/v1/health`: `503`
   when Postgres or Redis is down), and `curl -s http://127.0.0.1:4000/v1/health` says
   `"status":"ok"` with `"build":{"server":"<sha7>","sdk":"<sha7>"}`. Check `$C logs api` for
   `Loaded the keys of 5 of 5 hosted organisations` and `Verifier nha-tuyen-dung-mau is ready`.
6. Keep the tag: `echo "$IDENTRA_IMAGE_TAG" >> /srv/awncorp/identra-api/DEPLOYED` (the rollback list).
7. First time (and to reset the demo passwords), the sample data. Type the passwords, so they
   stay out of the shell history and the process list. Generate the registrar's on the admin
   machine (`openssl rand -base64 24`: 32 characters; at least 20 are required) and keep it in
   the password manager:

   ```bash
   read -rs -p 'student password (public): ' DEMO_PORTAL_PASSWORD; echo
   read -rs -p 'registrar password (private): ' DEMO_PORTAL_REGISTRAR_PASSWORD; echo
   export DEMO_PORTAL_PASSWORD DEMO_PORTAL_REGISTRAR_PASSWORD
   $C run --rm -e DEMO_PORTAL_PASSWORD -e DEMO_PORTAL_REGISTRAR_PASSWORD api node dist/src/scripts/demo-provision.js
   unset DEMO_PORTAL_PASSWORD DEMO_PORTAL_REGISTRAR_PASSWORD
   # the sample product chain (idempotent), and a second product with two stages only
   $C run --rm -e DEMO_PRODUCT_PROVISION=yes api node dist/src/scripts/demo-provision-product.js
   $C run --rm -e DEMO_PRODUCT_PROVISION=yes -e DEMO_PRODUCT_SERIAL=SN-2026-000002 -e DEMO_PRODUCT_STAGES=2 \
     api node dist/src/scripts/demo-provision-product.js
   ```

**Update** = steps 1, 2, 4, 5, 6 with the new commits. `up -d` replaces only the api container
(Postgres and Redis keep running).

**What a restart (or an update) does to work in flight.** The issuer's access-token, request
encryption and PIN keys live only in the process (`src/vc/issuers.ts`): every pending offer is
ended (the portal shows it as expired, the wallet says it expired; the student asks for a new
one), outstanding access tokens (at most 5 minutes old) stop working, so a wallet in the middle
of collecting a diploma must start again from a new offer. Everything else lives in Redis or
Postgres and carries on: portal sign-ins (30 minutes), open verification sessions and their
results (their keys are in Redis), app sessions, issued credentials, status lists, product
events, rate-limit counters. Requests during the few seconds of the switch fail at nginx (502).

## Rolling back an image

```bash
cat /srv/awncorp/identra-api/DEPLOYED           # previous tags, newest last
docker images identra-prod-api                  # still present?
cd /srv/awncorp/identra-api/identra-server
IDENTRA_IMAGE_TAG=<previous-tag> docker compose --env-file /etc/identra/server.env -f docker-compose.prod.yml up -d api
```

The image carries its own code; the source trees are only needed to build. Migrations only go
forward. An older image runs against the newer schema, which works only while migrations are
additive (new nullable columns, new tables: true of every migration so far, including
`portal_session_hash`). A release that drops or renames something needs a restore from the
nightly backup instead (ADR-0016 §4). Remove old images now and then
(`docker image rm identra-prod-api:<tag>`), keeping the last three.

### Base image

The Dockerfile pins `node:24-alpine` by tag AND digest (`ARG NODE_IMAGE`). To take a newer
build of the base (security fixes), on the admin machine:
`docker buildx imagetools inspect node:24-alpine` → the `Digest:` line of the index, put it in
the `ARG NODE_IMAGE=node:24-alpine@sha256:…` line, run the tests, commit, deploy.

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
   `docker compose ... run --rm api node_modules/.bin/prisma migrate resolve --rolled-back <migration_name>`
   (or `--applied <migration_name>` if you completed it by hand).
5. Fix the migration in the repository if it was wrong, deploy, or roll back the image as
   above. If the data is damaged, restore the nightly backup first.

## Redis memory

Redis runs with `--maxmemory 128mb --maxmemory-policy noeviction`: nothing is evicted
silently. When full, writes fail; `/v1/auth/*` then answers 503 (rate limiting fails
closed) and other REST routes run without rate limits; routes that must write answer 503.
The anonymous protocol state (verification sessions, c_nonces, offers) is capped across all
clients at about 56 MB in the worst case, each client (and each IPv6 /48) holding a fixed share
of every cap, and portal sessions are bounded by the sign-in rate at about 11 MB
(docs/vc-api.md §8; `VERIFICATION_MAX_LIVE_SESSIONS`, `ISSUANCE_MAX_LIVE_NONCES`,
`ISSUANCE_MAX_LIVE_OFFERS`). `/v1/health` reports `redis: degraded` (and `status: degraded`,
still HTTP 200) above 80 % of `maxmemory` or when a write is refused. Check with
`docker compose ... exec redis redis-cli info memory`.

## Edge rate limits (Cloudflare; a human must add them)

Every cap of docs/vc-api.md §8 has a per-client share (and a share per IPv6 /48), so one client,
or ten, cannot block the others. A distributed attacker with a hundred or more IPv4 addresses,
or 25 or more IPv6 /48s (tunnel brokers hand out several per free account), still can fill a global cap
(the memory bound) and keep the demo's offers, nonces or sessions refused (`503`) while it
lasts. The app cannot tell such clients apart; the remedy is at the edge. In the Cloudflare
dashboard of `awncorp.vn`: Security → WAF → Rate limiting rules, one rule per line, each
counting per IP, action **Block** (wallets and fetch calls cannot solve a challenge), response
`429`:

| Rule | Expression | Rate | Block for |
|---|---|---|---|
| identra nonce | `(http.host eq "api-identra.awncorp.vn" and http.request.method eq "POST" and starts_with(http.request.uri.path, "/issuers/") and ends_with(http.request.uri.path, "/nonce"))` | 10 per 1 minute | 1 minute |
| identra sessions | `(http.host eq "api-identra.awncorp.vn" and http.request.method eq "POST" and http.request.uri.path eq "/v1/verification/sessions")` | 10 per 1 minute | 1 minute |
| identra login | `(http.host eq "api-identra.awncorp.vn" and http.request.method eq "POST" and http.request.uri.path eq "/v1/demo/school/login")` | 10 per 1 minute | 1 minute |
| identra offers | `(http.host eq "api-identra.awncorp.vn" and http.request.method eq "POST" and http.request.uri.path eq "/v1/demo/school/offers")` | 10 per 1 minute | 1 minute |

Plans differ in how many rules and which periods they allow; with a single rule and a 10-second
period (the Free plan at the time of writing), use one rule with the four expressions joined by
`or` (inside one `http.host … and http.request.method eq "POST" and (…)`) at 5 requests per
10 seconds, blocking for 10 seconds. During an attack from many addresses, also turn on
"Under Attack" mode for `identra.awncorp.vn` (the website, where visitors start), not for
`api-identra` (wallets cannot pass its challenge). Check after saving: 12 quick
`curl -X POST https://api-identra.awncorp.vn/v1/demo/school/login` from one machine end in `429`
from Cloudflare (its own error page, before nginx).

## Rotation

What each secret protects in this code, how to change it and what the change ends. After an edit
of `/etc/identra/server.env` or of the key directory, recreate the api so it reads them:
`$C up -d --force-recreate api` (keys and secrets are read at start only; the trust-list source
is the exception, re-read on change).

- **Portal passwords** (`DEMO_PORTAL_PASSWORD`, `DEMO_PORTAL_REGISTRAR_PASSWORD`): run Deploy
  step 7 again with new values. Sign-ins with the old password fail at once; portal sessions
  already open stay valid until their 30 minutes end (they live in Redis and do not depend on
  the password). To end them at once:
  `$C exec redis sh -c 'redis-cli --scan --pattern "state:portal-session:*" | xargs -r redis-cli del'`.
- **Organisation API keys** (`IDENTRA_ORG_API_KEY_HASHES`, `org:sha256hex`, several entries per
  organisation allowed): add the hash of the new key next to the old one, recreate the api, hand
  the new key over, then remove the old hash and recreate again. A removed key is refused from
  the next start on.
- **`JWT_ACCESS_SECRET`**: every app access token stops working at once (they live 15 minutes;
  apps refresh). **`JWT_REFRESH_SECRET`**: refresh tokens are stored as an HMAC with it, so every
  app user must sign in again. **`AUTH_REGISTRATION_TOKEN_SECRET`**: registrations in progress
  (15 minutes) must start again. **`OTP_HMAC_SECRET`**: OTP codes already sent (5 minutes) stop
  matching. **`PASSWORD_PEPPER`: do not rotate.** Every app password is hashed with it and the
  code verifies with the current pepper only (`PASSWORD_PEPPER_VERSION` is recorded, not used
  to pick one): a new pepper locks every app user out until they reset their password.
- **Signing keys and certificates of the organisations** (ADR-0015 §14): a key signs only during
  its first 12 months; its certificate lives longer so that what it signed still verifies
  (diploma `vc` 3 years, product `vc-product` 11 years, `request` and `status` 13 months). To
  rotate one, on the offline admin machine with the Issuing CA: issue the new key and
  certificate (`identra-sdk/scripts/pki`), ADD the new certificate's fingerprint with its
  purpose to that organisation's `chung_thu` in `trust-list.source.json` and KEEP the old entry
  until the old certificate's `notAfter` (diplomas and product events it signed must keep
  verifying), copy the new `orgs/<name>/<purpose>.{key,chain}.pem` over the old files (owner
  10001, mode 600 for the key), recreate the api, check health and the log line `Loaded the keys
  of 5 of 5 hosted organisations`, then destroy every copy of the old private key. A `request`
  certificate missing from the trust list stops session creation (`verifier: down`) until the
  list has it: edit the source first.
- **Trust-list signer** (`trust-list-signer/trust-list.{key,cert}.pem`, Root-issued, 13 months):
  every list carries `signer_not_before` = the notBefore of the certificate that signed it, and
  wallets remember the largest value they have seen and refuse any list signed by a certificate
  with an earlier notBefore. So: issue the new certificate (its notBefore is later, never
  backdate it), replace both files, recreate the api, and never go back to the old signer once a
  list from the new one was served, not even for a rollback (an older image signs with whatever
  key files are mounted, so the files decide). The server keeps its last `iat` in Redis
  (`state:trust-list:last-iat`), so the new lists continue with a later `iat`.
