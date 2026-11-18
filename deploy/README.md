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
`chmod 600` every `*.key.pem`, `chmod 700` the directories. The server loads every key at
startup and refuses to start, naming the file, when one is missing or does not validate.

Editing `trust-list.source.json` takes effect on the next request (re-read when its mtime
changes). An invalid edit keeps the last good list in service, logs a warning, and
`/v1/health` keeps `trustList: up` until that list expires (24 h): check the log after
every edit.

The school portal's sample accounts (idempotent; run again to reset their password):

```bash
docker compose --env-file /etc/identra/server.env -f docker-compose.prod.yml \
  run --rm -e DEMO_PORTAL_PASSWORD='Identra@2026' api npm run demo:provision
```

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
closed) and other REST routes run without rate limits. Check with
`docker compose ... exec redis redis-cli info memory`.
