import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';

import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApp } from '../src/configure-app';

// Env overrides must be in place before AppModule is loaded (ConfigModule validates at
// import time), so AppModule is imported lazily. Each test file runs in its own process.
export async function createTestApp(
  env: Record<string, string> = {},
  controllers: Array<new (...args: never[]) => unknown> = []
): Promise<NestExpressApplication> {
  Object.assign(process.env, env);

  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

  configureApp(app);
  await app.init();

  return app;
}

export function randomPhone(): string {
  return `+849${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

export function randomDevice() {
  return { deviceId: `test-${randomBytes(8).toString('hex')}`, platform: 'ios' };
}

export interface RegisteredUser {
  id: string;
  phone: string;
  accessToken: string;
}

/** Registers a user through the real auth flow (demo OTP must be enabled). */
export async function registerUser(app: NestExpressApplication): Promise<RegisteredUser> {
  const http = request(app.getHttpServer());
  const phone = randomPhone();
  const device = randomDevice();

  const start = await http.post('/v1/auth/register/start').send({ phone, device }).expect(201);
  // Outside production the documented contract still hands out the demo code.
  assert.equal(start.body.data.delivery.demoOtp, '000000');
  const verify = await http
    .post('/v1/auth/register/verify')
    .send({ challengeId: start.body.data.challengeId, phone, otpCode: '000000', device })
    .expect(201);
  const password = await http
    .post('/v1/auth/register/password')
    .send({
      registrationToken: verify.body.data.registration.registrationToken,
      password: 'Correct-Horse-9',
      device
    })
    .expect(201);

  return {
    id: password.body.data.user.id,
    phone,
    accessToken: password.body.data.tokens.accessToken
  };
}
