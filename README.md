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

The setup step applies the migrations (`prisma migrate deploy`), empties every table and the
Redis database (it refuses unless `.env.test` points at a local `*test*` database), and stops
with an error if either database is unreachable. Remove the containers and their volumes afterwards:

```bash
docker rm -f -v identra-s0-pg identra-s0-redis
```

## Production

The VPS runs `docker-compose.prod.yml` (ADR-0016); `docker-compose.yml` is for developer
machines only. Both build from the parent directory (`context: ..`). Secrets come from
`/etc/identra/server.env` (template: `.env.production.example`), signing keys from
`/etc/identra/keys`:

```bash
docker compose --env-file /etc/identra/server.env -f docker-compose.prod.yml up -d --build
```

The api container runs `prisma migrate deploy` and then the server; schema changes ship as
migrations in `prisma/migrations`, never `db push`.

nginx configuration, deploy, image rollback and the failed-migration runbook:
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
