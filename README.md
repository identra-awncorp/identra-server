# Identra Server

NestJS backend for Identra mobile app, website demos, and future super-app modules.

## Stack

- Node.js 22
- NestJS 11
- Prisma 6
- PostgreSQL
- Redis
- Docker Compose

## Requirements

Before running the project, make sure your local environment has:

- Node.js `22.x` recommended, `20.x` minimum
- npm from the selected Node.js version
- Docker Desktop with Docker Compose V2

Check versions:

```bash
node -v
npm -v
docker --version
docker compose version
```

The Docker image for this project uses Node.js 22, so local development should
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
npm run prisma:push
npm run seed
npm run start:dev
```

PowerShell:

```powershell
npm.cmd ci
npm.cmd run prisma:generate
npm.cmd run prisma:push
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
npm run prisma:generate
npm run prisma:push
npm run seed
npm run docker:up
npm run docker:down
```

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
