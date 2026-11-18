import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';

import * as argon2 from 'argon2';

import { configureApp } from '../src/configure-app';
import { DEMO_ACCOUNTS, DEMO_ISSUER, PORTAL_PASSWORD_HASH } from '../src/demo-portal/demo-accounts';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';

export const TEST_PASSWORD = 'Correct-Horse-9';

interface TestAppOptions {
  controllers?: Array<new (...args: never[]) => unknown>;
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** Skip clearing rate-limit counters (when Redis is deliberately unreachable). */
  keepRateLimits?: boolean;
}

// Env overrides must be in place before AppModule is loaded (ConfigModule validates at
// import time), so AppModule is imported lazily. Each test file runs in its own process.
export async function createTestApp(
  env: Record<string, string> = {},
  { controllers = [], override = (builder) => builder, keepRateLimits = false }: TestAppOptions = {}
): Promise<NestExpressApplication> {
  Object.assign(process.env, env);

  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await override(Test.createTestingModule({ imports: [AppModule], controllers })).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

  configureApp(app);
  await app.init();

  if (!keepRateLimits) {
    // Counters are shared through Redis; every test file starts with a clean budget.
    const redis = app.get(RedisService).getClient();
    const keys = await redis.keys('throttle:*');

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  return app;
}

/**
 * The demo PKI (identra-sdk/scripts/pki/make-demo-pki.sh, outside git) for the credential tests.
 * Missing → the test file fails with this message; it is never skipped.
 */
export function testKeysDir(): string {
  const dir = process.env.IDENTRA_TEST_KEYS_DIR || join(homedir(), '.identra', 'demo-pki');

  if (!existsSync(join(dir, 'root.cert.pem')) || !existsSync(join(dir, 'trust-list.source.json'))) {
    throw new Error(
      `No demo PKI at ${dir}. Create it with identra-sdk/scripts/pki/make-demo-pki.sh <dir> and ` +
        'make-trust-list-source.mjs, or set IDENTRA_TEST_KEYS_DIR in .env.test (README, "Tests").'
    );
  }

  return dir;
}

/** A production configuration that passes every startup check. */
export function productionEnv(keysDir = testKeysDir()) {
  const secret = () => randomBytes(48).toString('base64');

  return {
    NODE_ENV: 'production',
    IDENTRA_KEYS_DIR: keysDir,
    CORS_ORIGINS: 'https://identra.awncorp.vn',
    JWT_ACCESS_SECRET: secret(),
    JWT_REFRESH_SECRET: secret(),
    AUTH_REGISTRATION_TOKEN_SECRET: secret(),
    PASSWORD_PEPPER: secret(),
    OTP_HMAC_SECRET: secret()
  };
}

export function randomPhone(): string {
  return `+849${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

export function randomDevice() {
  return { deviceId: `test-${randomBytes(8).toString('hex')}`, platform: 'ios' };
}

/** A documentation-range IPv4 address, sent as the (single, trusted) X-Forwarded-For hop. */
export function randomIp(): string {
  return `198.51.100.${randomInt(1, 255)}`;
}

export interface RegisteredUser {
  id: string;
  phone: string;
  device: ReturnType<typeof randomDevice>;
  accessToken: string;
}

/** Registers a user through the real auth flow (demo OTP must be enabled). */
export async function registerUser(app: NestExpressApplication): Promise<RegisteredUser> {
  const http = request(app.getHttpServer());
  const phone = randomPhone();
  const device = randomDevice();
  // Its own client IP, so registrations do not share one per-IP rate-limit budget.
  const ip = randomIp();

  const start = await http
    .post('/v1/auth/register/start')
    .set('X-Forwarded-For', ip)
    .send({ phone, device })
    .expect(201);
  // Outside production the documented contract still hands out the demo code.
  assert.equal(start.body.data.delivery.demoOtp, '000000');
  const verify = await http
    .post('/v1/auth/register/verify')
    .set('X-Forwarded-For', ip)
    .send({ challengeId: start.body.data.challengeId, phone, otpCode: '000000', device })
    .expect(201);
  const password = await http
    .post('/v1/auth/register/password')
    .set('X-Forwarded-For', ip)
    .send({ registrationToken: verify.body.data.registration.registrationToken, password: TEST_PASSWORD, device })
    .expect(201);

  return {
    id: password.body.data.user.id,
    phone,
    device,
    accessToken: password.body.data.tokens.accessToken
  };
}

export const TEST_PORTAL_PASSWORD = 'Identra@2026';

/** The sample portal accounts, plus a registrar of another issuer for authorisation tests. */
export async function seedPortalAccounts(prisma: PrismaService): Promise<void> {
  const passwordHash = await argon2.hash(TEST_PORTAL_PASSWORD, PORTAL_PASSWORD_HASH);
  const accounts = [
    ...DEMO_ACCOUNTS.map((a) => ({ username: a.username, role: a.role, issuerName: DEMO_ISSUER, profile: { ...a.profile } })),
    { username: 'phongqlcl-nsx', role: 'registrar' as const, issuerName: 'nha-san-xuat', profile: { hoTen: 'Mẫu', donVi: 'DEMO' } }
  ];

  for (const { username, ...data } of accounts) {
    await prisma.demoPortalAccount.upsert({
      where: { username },
      create: { username, passwordHash, ...data },
      update: { passwordHash, ...data }
    });
  }
}

export async function portalLogin(app: NestExpressApplication, username: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/v1/demo/school/login')
    .set('X-Forwarded-For', randomIp())
    .send({ username, password: TEST_PORTAL_PASSWORD })
    .expect(201);

  return res.body.token;
}
