import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createTestApp, productionEnv, randomDevice, randomPhone } from './helpers';

const CODE = '580274';
const allowedPhone = randomPhone();
let app: NestExpressApplication;

// A production-mode app that explicitly opts in to the demo OTP for one listed number.
before(async () => {
  app = await createTestApp({
    ...productionEnv(),
    OTP_DEMO_ENABLED: 'true',
    OTP_DEMO_CODE: CODE,
    OTP_DEMO_PHONE_ALLOWLIST: allowedPhone
  });
});

after(async () => {
  await app?.close();
});

describe('demo OTP opted in under NODE_ENV=production', () => {
  it('never returns the code, but accepts it for an allow-listed number', async () => {
    const http = request(app.getHttpServer());
    const device = randomDevice();

    const start = await http.post('/v1/auth/register/start').send({ phone: allowedPhone, device }).expect(201);

    assert.equal(start.body.data.delivery.demoOtp, undefined);
    assert.ok(!JSON.stringify(start.body).includes(CODE));

    await http
      .post('/v1/auth/register/verify')
      .send({ challengeId: start.body.data.challengeId, phone: allowedPhone, otpCode: '000000', device })
      .expect(401);

    const verify = await http
      .post('/v1/auth/register/verify')
      .send({ challengeId: start.body.data.challengeId, phone: allowedPhone, otpCode: CODE, device })
      .expect(201);

    assert.equal(verify.body.data.registration.nextAction, 'SET_PASSWORD');
  });

  it('refuses numbers outside OTP_DEMO_PHONE_ALLOWLIST with 503', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register/start')
      .send({ phone: randomPhone(), device: randomDevice() })
      .expect(503);

    assert.equal(res.body.code, 'OTP_PROVIDER_UNAVAILABLE');
  });

  it('does not serve Swagger or advertise it', async () => {
    await request(app.getHttpServer()).get('/docs').expect(404);
    await request(app.getHttpServer()).get('/docs-json').expect(404);
    const info = await request(app.getHttpServer()).get('/v1').expect(200);

    assert.equal(info.body.docs, undefined);
  });
});
