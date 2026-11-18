import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { createTestApp, productionEnv, randomDevice, randomPhone } from './helpers';

// Production mode with Postgres and Redis pointing nowhere: nothing about them may leak.
const DEAD_DB = 'postgresql://identra:x@127.0.0.1:1/nowhere?connect_timeout=2';
const DEAD_REDIS = 'redis://127.0.0.1:2';

class UnconnectedPrismaService extends PrismaService {
  // Real PrismaService connects at startup; here queries simply fail later.
  async onModuleInit() {}
}

let app: NestExpressApplication;

before(async () => {
  app = await createTestApp(
    { ...productionEnv(), DATABASE_URL: DEAD_DB, REDIS_URL: DEAD_REDIS },
    {
      keepRateLimits: true,
      override: (builder) => builder.overrideProvider(PrismaService).useClass(UnconnectedPrismaService)
    }
  );
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());
const leaks = (body: unknown) => /127\.0\.0\.1|nowhere|prisma|ECONNREFUSED/i.test(JSON.stringify(body));

describe('production errors do not leak infrastructure details (F6)', () => {
  it('GET /v1/health reports components down without reasons', async () => {
    const res = await http().get('/v1/health').expect(200);

    assert.deepEqual(res.body.services, { database: { status: 'down' }, redis: { status: 'down' } });
    assert.equal(res.body.status, 'degraded');
  });

  it('GraphQL replaces database errors with a generic message', async () => {
    const res = await http().post('/graphql').send({ query: '{ miniApps { id } }' });

    assert.equal(res.body.errors[0].message, 'Internal server error');
    assert.equal(res.body.errors[0].extensions.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(leaks(res.body), false, JSON.stringify(res.body));
  });

  it('GraphQL masks a database failure while resolving the caller too', async () => {
    // Validly signed, so the session lookup runs against the dead database.
    const token = app.get(JwtService, { strict: false }).sign(
      { sub: 'u', sid: 's', lid: 'l', token_use: 'access', role: 'user', scopes: ['user'] },
      { secret: app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET'), expiresIn: 60 }
    );
    const res = await http().post('/graphql').auth(token, { type: 'bearer' }).send({ query: '{ viewer { id } }' });

    assert.equal(res.body.errors[0].message, 'Internal server error');
    assert.equal(leaks(res.body), false, JSON.stringify(res.body));
  });

  it('GraphQL validation errors keep their message but lose "Did you mean" hints', async () => {
    const res = await http().post('/graphql').send({ query: '{ viewr { id } }' });

    assert.match(res.body.errors[0].message, /Cannot query field "viewr"/);
    assert.doesNotMatch(res.body.errors[0].message, /Did you mean/);
  });
});

describe('rate limiting without Redis', () => {
  it('fails closed on /v1/auth with 503', async () => {
    const res = await http()
      .post('/v1/auth/register/start')
      .send({ phone: randomPhone(), device: randomDevice() })
      .expect(503);

    assert.equal(res.body.code, 'RATE_LIMIT_UNAVAILABLE');
    await http().get('/v1/auth/status').expect(503);
  });

  it('fails open elsewhere', async () => {
    await http().get('/v1').expect(200);
  });
});
