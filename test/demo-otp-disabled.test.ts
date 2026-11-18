import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createTestApp, randomDevice, randomPhone } from './helpers';

let app: NestExpressApplication;

before(async () => {
  app = await createTestApp({ OTP_DEMO_ENABLED: 'false' });
});

after(async () => {
  await app?.close();
});

describe('OTP_DEMO_ENABLED=false', () => {
  it('register/start refuses with 503 instead of issuing the fixed code', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register/start')
      .send({ phone: randomPhone(), device: randomDevice() })
      .expect(503);

    assert.equal(res.body.code, 'OTP_PROVIDER_UNAVAILABLE');
    assert.ok(!JSON.stringify(res.body).includes('000000'));
  });

  it('register/verify refuses the fixed code with 503', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/register/verify')
      .send({ challengeId: 'any', phone: randomPhone(), otpCode: '000000', device: randomDevice() })
      .expect(503);

    assert.equal(res.body.code, 'OTP_PROVIDER_UNAVAILABLE');
  });

  it('login/verify refuses the fixed code with 503', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login/verify')
      .send({ challengeId: 'any', phone: randomPhone(), otpCode: '000000', device: randomDevice() })
      .expect(503);

    assert.equal(res.body.code, 'OTP_PROVIDER_UNAVAILABLE');
  });
});
