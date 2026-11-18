import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createTestApp, randomDevice, randomPhone, registerUser, TEST_PASSWORD } from './helpers';

let app: NestExpressApplication;

before(async () => {
  app = await createTestApp();
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());
const loginStart = (phone: string, ip: string, password = 'Wrong-Password-1', device = randomDevice()) =>
  http().post('/v1/auth/login/start').set('X-Forwarded-For', ip).send({ phone, password, device });

describe('REST rate limits (Redis-backed)', () => {
  it('limits login/start to 10 per minute per client IP', async () => {
    const ip = '203.0.113.10';

    for (let i = 0; i < 10; i += 1) {
      // Unknown numbers: 404, but each attempt counts.
      await loginStart(randomPhone(), ip).expect(404);
    }

    const blocked = await loginStart(randomPhone(), ip).expect(429);
    assert.ok(blocked.headers['retry-after']);

    // Another client is unaffected.
    await loginStart(randomPhone(), '203.0.113.11').expect(404);
  });

  it('spoofed leading X-Forwarded-For entries do not buy a fresh budget', async () => {
    const realIp = '203.0.113.20';

    for (let i = 0; i < 10; i += 1) {
      await loginStart(randomPhone(), `10.0.0.${i}, ${realIp}`).expect(404);
    }

    await loginStart(randomPhone(), `10.9.9.9, ${realIp}`).expect(429);
  });

  it('limits attempts per phone number even from rotating IPs', async () => {
    const phone = randomPhone();

    for (let i = 0; i < 10; i += 1) {
      await loginStart(phone, `203.0.113.${100 + i}`).expect(404);
    }

    const blocked = await loginStart(phone, '203.0.113.200').expect(429);
    assert.ok(blocked.headers['retry-after-phone']);
  });

  it('applies the global per-IP default to other routes', async () => {
    const res = await http().get('/v1/auth/status').set('X-Forwarded-For', '203.0.113.30').expect(200);

    assert.equal(res.headers['x-ratelimit-limit'], '300');
  });
});

describe('password lockout cannot be used to lock a user out remotely', () => {
  it('locks new devices after 5 wrong passwords, but the trusted device still logs in', async () => {
    const victim = await registerUser(app);

    // Attacker: 5 wrong passwords from 5 IPs and fresh device ids.
    for (let i = 0; i < 5; i += 1) {
      await loginStart(victim.phone, `192.0.2.${i + 1}`).expect(401);
    }

    // Even the right password is refused from an unknown device while locked.
    const locked = await loginStart(victim.phone, '192.0.2.50', TEST_PASSWORD).expect(423);
    assert.equal(locked.body.code, 'PASSWORD_LOCKED');

    // The owner's trusted device with the right password is not locked out.
    const owner = await loginStart(victim.phone, '198.51.100.7', TEST_PASSWORD, victim.device).expect(201);
    assert.ok(owner.body.data.tokens.accessToken);

    // A wrong password from the trusted device is still refused.
    await loginStart(victim.phone, '198.51.100.7', 'Wrong-Password-2', victim.device).expect(401);
  });
});
