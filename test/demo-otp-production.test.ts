import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createTestApp, randomDevice, randomPhone } from './helpers';

let app: NestExpressApplication;

// A production-mode app (strong secrets, explicit CORS) that explicitly opts in to the demo OTP.
before(async () => {
  app = await createTestApp({
    NODE_ENV: 'production',
    OTP_DEMO_ENABLED: 'true',
    CORS_ORIGINS: 'https://identra.awncorp.vn',
    JWT_ACCESS_SECRET: 'p'.repeat(40),
    JWT_REFRESH_SECRET: 'q'.repeat(40),
    AUTH_REGISTRATION_TOKEN_SECRET: 'r'.repeat(40),
    PASSWORD_PEPPER: 's'.repeat(40),
    OTP_HMAC_SECRET: 't'.repeat(40)
  });
});

after(async () => {
  await app?.close();
});

describe('demo OTP opted in under NODE_ENV=production', () => {
  it('never returns demoOtp, but still accepts the code', async () => {
    const http = request(app.getHttpServer());
    const phone = randomPhone();
    const device = randomDevice();

    const start = await http.post('/v1/auth/register/start').send({ phone, device }).expect(201);

    assert.equal(start.body.data.delivery.demoOtp, undefined);
    assert.ok(!JSON.stringify(start.body).includes('000000'));

    const verify = await http
      .post('/v1/auth/register/verify')
      .send({ challengeId: start.body.data.challengeId, phone, otpCode: '000000', device })
      .expect(201);

    assert.equal(verify.body.data.registration.nextAction, 'SET_PASSWORD');
  });
});
