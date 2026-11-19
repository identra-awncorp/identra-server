# Identra Server

NestJS backend for Identra mobile app, website demos, and future super-app modules.

## Stack

- Node.js 24 (minimum 22.12)
- NestJS 11
- Prisma 6
- PostgreSQL
- Redis
- Docker Compose

## Requirements

Before running the project, make sure your local environment has:

- Node.js `24.x` recommended, `22.12` minimum (needed to `require()` ESM-only packages)
- npm from the selected Node.js version
- Docker Desktop with Docker Compose V2

Check versions:

```bash
node -v
npm -v
docker --version
docker compose version
```

The Docker image for this project uses Node.js 24, so local development should
use the same major version whenever possible.

On Windows, reopen Git Bash or PowerShell after installing Node.js or Docker so
the terminal can reload the updated `PATH`.

### The Identra SDK

The server uses `@identra/sdk-core` and `@identra/sdk-server` from the sibling directory
`../identra-sdk` (`file:` dependencies, ADR-0005); the tests also use `@identra/sdk-app` (the
wallet) as a dev dependency. Build the SDK there first, installing its dependencies without
install scripts (its README explains why):

```bash
(cd ../identra-sdk && npm ci --ignore-scripts && npm run build)
npm ci && npm run lint && npm run build && npm test
```

After an SDK rebuild, restart the server; run `npm install` here again only when an SDK
`package.json` changed. The SDK packages are ES modules imported by name from the CommonJS
server (`import … from '@identra/sdk-server'`); Node 24 loads them with `require(esm)`.

### Credential features (optional locally)

Trust list, status lists, issuance and verification need organisation keys
(`IDENTRA_KEYS_DIR`, layout of `identra-sdk/scripts/pki/make-demo-pki.sh`). A local demo set,
kept outside the repository:

```bash
../identra-sdk/scripts/pki/make-demo-pki.sh ~/.identra/demo-pki
node ../identra-sdk/scripts/pki/make-trust-list-source.mjs ~/.identra/demo-pki --out ~/.identra/demo-pki/trust-list.source.json
# The demo set keeps its CA keys in ca/; the server refuses a key directory that holds CA keys
# (ADR-0015 §2), so point it at a view without them:
mkdir -m 700 ~/.identra/server-keys && for f in orgs trust-list-signer root.cert.pem trust-list.source.json; do
  ln -s ~/.identra/demo-pki/$f ~/.identra/server-keys/$f; done
```

Then set `IDENTRA_KEYS_DIR=$HOME/.identra/server-keys` (absolute path) in `.env`. Without it the
server runs without those routes. Sample data, after `npm run build`:
`DEMO_PORTAL_PASSWORD='Identra@2026' DEMO_PORTAL_REGISTRAR_PASSWORD='<private, 12+ characters>' npm run demo:provision`
(school portal accounts: the students' public password and the registrar's own) and
`DEMO_PRODUCT_PROVISION=yes npm run demo:provision-product` (the sample product chain; add
`DEMO_PRODUCT_SERIAL=SN-2026-000002 DEMO_PRODUCT_STAGES=2` for a product still in progress).

## Environment

Create a local environment file:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

The default `.env.example` values are configured for running the API directly on
the host machine:

```text
DATABASE_URL=postgresql://identra:identra_password@localhost:5432/identra?schema=public
REDIS_URL=redis://localhost:6379
```

Docker Compose overrides these values for the API container so it can connect to
the `db` and `redis` services inside the compose network.

## Run With Docker

Recommended for local development:

```bash
cp .env.example .env
docker compose up --build
```

PowerShell:

```powershell
Copy-Item .env.example .env
npm.cmd run docker:up
```

Stop containers:

```bash
docker compose down
```

## Run Without Docker

Use this only when PostgreSQL and Redis are already running locally.

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run seed
npm run start:dev
```

PowerShell:

```powershell
npm.cmd ci
npm.cmd run prisma:generate
npm.cmd run prisma:deploy
npm.cmd run seed
npm.cmd run start:dev
```

## URLs

API:

```text
http://localhost:4000/v1
```

Swagger:

```text
http://localhost:4000/docs
```

GraphQL:

```text
http://localhost:4000/graphql
```

Health check:

```text
http://localhost:4000/v1/health
```

LAN health check for a real phone on the same Wi-Fi:

```text
http://<your-computer-LAN-IP>:4000/v1/health
http://<your-computer-LAN-IP>:4000/v1/auth/status
```

The server binds to `HOST=0.0.0.0` by default so Android phones running Expo Go
can reach it through the computer's LAN IP. If the localhost URL works but the
LAN URL does not, check Windows Firewall, Docker Desktop port publishing, and
whether the phone is on the same Wi-Fi network without client isolation.

## Development Commands

```bash
npm run start:dev
npm run lint
npm run build
npm test
npm run prisma:generate
npm run prisma:deploy     # apply committed migrations
npm run prisma:migrate    # create a new migration after editing schema.prisma
npm run seed
npm run docker:up
npm run docker:down
```

## Tests

`npm test` compiles the tests in `test/` and runs them with Node's built-in test runner
against a real Postgres and Redis. Start two throwaway containers (project-specific names and
ports, so they do not clash with the dev stack on 5432/6379):

```bash
docker run -d --name identra-s0-pg -e POSTGRES_USER=identra -e POSTGRES_PASSWORD=identra_test \
  -e POSTGRES_DB=identra_test -p 127.0.0.1:47432:5432 postgres:16-alpine
docker run -d --name identra-s0-redis -p 127.0.0.1:47379:6379 redis:7-alpine
cp .env.test.example .env.test
npm test
```

The end-to-end files listen on `127.0.0.1:47400`; on a shared machine pick a free port with
`IDENTRA_TEST_PORT` in `.env.test` (and other container ports in its URLs).

The setup step applies the migrations (`prisma migrate deploy`), empties every table and the
Redis database (it refuses unless `.env.test` points at a local `*test*` database), and stops
with an error if either database is unreachable.

Tests that start the app with the credential features need the demo PKI above
(`IDENTRA_TEST_KEYS_DIR` in `.env.test`, default `~/.identra/demo-pki`, read only; the tests
link its server part into a temporary directory without `ca/`): every `vc-*` file, and the
production-mode files `demo-otp-production` and `dependencies-down` (production requires
`IDENTRA_KEYS_DIR`). They fail with a message saying how to create it when it is missing. The
other files (`access-control`, `app-setup`, `demo-otp-disabled`, `demo-portal`, `env-validation`,
`rate-limit`) need no keys. Remove the containers and their volumes afterwards:

```bash
docker rm -f -v identra-s0-pg identra-s0-redis
```

## Production

The VPS runs `docker-compose.prod.yml` (ADR-0016); `docker-compose.yml` is for developer
machines only. The production image is built on the VPS with `docker build` from the parent
directory holding `identra-sdk/` and `identra-server/` at pinned commits (the SDK is compiled
inside the image; the VPS needs only Docker); Compose then runs that tag. Secrets come from
`/etc/identra/server.env` (template: `.env.production.example`), signing keys from
`/etc/identra/keys` (owned by uid 10001, the container's user). The api container runs
`prisma migrate deploy` and then the server; schema changes ship as migrations in
`prisma/migrations`, never `db push`.

The exact procedure (layout, build with the two commits, first boot, provisioning, update,
rollback), nginx, the Cloudflare rules, rotation and the failed-migration runbook:
`deploy/README.md`.

## Architecture

This project starts as a modular monolith. It deploys as one API service for now,
but source code is split by business domain so modules can be extracted later if
needed.

```text
src/
  common/          shared DTOs and helpers
  config/          environment parsing
  contracts/       API contract schemas
  infrastructure/  database, redis, queues, storage, realtime
  modules/         product domains
```
