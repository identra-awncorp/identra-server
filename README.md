# Identra Server

NestJS backend for Identra mobile app, website demos, and future super-app modules.

## Stack

- NestJS
- Prisma
- PostgreSQL
- Redis
- Docker Compose

## Local Docker Run

```bash
cp .env.example .env
docker compose up --build
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm.cmd run docker:up
```

The API listens on:

```text
http://localhost:4000/v1
```

Swagger docs:

```text
http://localhost:4000/docs
```

Health check:

```text
http://localhost:4000/v1/health
```

Auth integration guide:

```text
docs/auth-flow.md
```

Auth production readiness checklist:

```text
docs/auth-production-readiness.md
```

## Development Commands

```bash
npm install
npm run start:dev
npm run lint
npm run prisma:generate
npm run prisma:push
npm run seed
```

If PowerShell blocks `npm.ps1`, use `npm.cmd run <script>` instead.

When running the API outside Docker, update `DATABASE_URL` and `REDIS_URL` to use
`localhost` instead of the Docker service names `db` and `redis`.

## Architecture

This project starts as a modular monolith. It deploys as one API service for now,
but source code is split by business domain so modules can be extracted later if
the product needs it.

```text
src/
  common/          shared DTOs and helpers
  config/          environment parsing
  contracts/       API contract schemas shared with app/website later
  infrastructure/  database, redis, queues, storage, realtime
  modules/         product domains
```

Initial product modules:

- auth
- users
- identity
- credentials
- sharing
- verification
- chat
- feed
- payments
- notifications
- mini-apps
- demo-scenarios
- audit

## Docker Notes

The app, PostgreSQL, and Redis are separate containers in one compose project.
That is the recommended local/demo setup. For production, keep the API image
separate and use managed PostgreSQL/Redis or dedicated infrastructure services.
