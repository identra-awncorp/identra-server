// Runs once before the test files (see `npm test`): checks that the throwaway Postgres and
// Redis from .env.test are reachable, then applies the committed migrations. Any problem
// stops the run with a clear message; tests are never skipped silently.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const HOW_TO = 'Start the test containers as described in README.md ("Tests").';

function fail(message: string): never {
  console.error(`\n[test setup] ${message}\n${HOW_TO}\n`);
  process.exit(1);
}

async function main() {
  if (!existsSync('.env.test')) {
    fail('.env.test not found. Copy .env.test.example to .env.test.');
  }

  process.loadEnvFile('.env.test');

  for (const name of ['DATABASE_URL', 'REDIS_URL']) {
    if (!process.env[name]) {
      fail(`${name} is not set in .env.test.`);
    }
  }

  const prisma = new PrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    fail(`Postgres is unreachable at DATABASE_URL (${redactUrl(process.env.DATABASE_URL!)}).`);
  } finally {
    await prisma.$disconnect();
  }

  const redis = new Redis(process.env.REDIS_URL!, {
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null
  });

  try {
    await redis.connect();
    await redis.ping();
  } catch {
    fail(`Redis is unreachable at REDIS_URL (${redactUrl(process.env.REDIS_URL!)}).`);
  } finally {
    redis.disconnect();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', env: process.env });
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.password = url.password ? '***' : '';

    return url.toString();
  } catch {
    return '(unparseable URL)';
  }
}

void main();
