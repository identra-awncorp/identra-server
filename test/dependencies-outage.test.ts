// M4: with Redis down, then with Postgres down, every route family answers at once with 503
// (UNAVAILABLE + Retry-After on /v1, temporarily_unavailable on protocol routes) or with what it
// can still serve, never 500 and never after seconds of waiting. The app reaches both stores
// through TCP proxies in this process, so a test can cut one and bring it back.
import assert from 'node:assert/strict';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';

import type { StatusListService } from '@identra/sdk-server';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { RedisService } from '../src/infrastructure/redis/redis.service';
import { STATUS_LIST_SERVICE } from '../src/vc/vc.providers';
import { createTestApp, seedPortalAccounts, testKeysDir } from './helpers';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/** A TCP proxy to `target` that can be stopped (connections cut, port closed) and started again. */
function tcpProxy(target: URL) {
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let port = 0;

  return {
    get port() {
      return port;
    },
    start: () =>
      new Promise<void>((resolve) => {
        server = createServer((client) => {
          const upstream = connect(Number(target.port), target.hostname);
          const end = () => {
            client.destroy();
            upstream.destroy();
          };

          for (const s of [client, upstream]) {
            sockets.add(s);
            s.on('error', end).on('close', () => sockets.delete(s));
          }
          client.pipe(upstream).pipe(client);
        });
        server.listen(port, '127.0.0.1', () => {
          port = (server!.address() as AddressInfo).port;
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server!.close(() => resolve());
      })
  };
}

const db = new URL(process.env.DATABASE_URL!);
const pg = tcpProxy(db);
const redisProxy = tcpProxy(new URL(process.env.REDIS_URL!));
let app: NestExpressApplication;
const ID = 'A'.repeat(22);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

before(async () => {
  await pg.start();
  await redisProxy.start();

  const viaProxy = new URL(db);

  viaProxy.port = String(pg.port);
  viaProxy.searchParams.set('connect_timeout', '2');
  app = await createTestApp({
    IDENTRA_KEYS_DIR: testKeysDir(),
    DATABASE_URL: viaProxy.toString(),
    REDIS_URL: `redis://127.0.0.1:${redisProxy.port}`
  });
  await seedPortalAccounts(app.get(PrismaService));
});

after(async () => {
  await app?.close();
  await pg.stop().catch(() => undefined);
  await redisProxy.stop().catch(() => undefined);
});

const http = () => request(app.getHttpServer());
let ipSeq = 0;
type Probe = [method: 'get' | 'post', path: string, body?: string | object, headers?: Record<string, string>];

/** Every route family of the reviewer's list (t15-down.mjs), plus the app's own sign-in. */
const PROBES: Probe[] = [
  ['get', '/v1/health'],
  ['get', '/trust-list'],
  ['get', '/issuers/truong-mau/status/1'],
  ['get', '/.well-known/openid-credential-issuer/issuers/truong-mau'],
  ['get', `/issuers/truong-mau/offers/${ID}`],
  ['post', '/issuers/truong-mau/token', `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code&pre-authorized_code=${'A'.repeat(43)}&tx_code=123456`, FORM],
  ['post', '/issuers/truong-mau/nonce'],
  ['post', '/issuers/truong-mau/credential', {}, { authorization: 'Bearer x' }],
  ['post', '/v1/demo/school/login', { username: 'sv001', password: 'Identra@2026' }],
  ['post', '/v1/verification/sessions', { verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' }],
  ['get', `/v1/verification/sessions/${ID}`],
  ['get', `/oid4vp/request/${ID}`],
  ['post', `/oid4vp/response/${ID}`, 'response=x', FORM],
  ['get', '/v1/products/09520123456788/SN-2026-000001/events'],
  ['post', '/v1/products/09520123456788/SN-2026-000009/events', { credential: 'x' }, { authorization: 'Bearer some-organisation-api-key' }],
  ['post', `/v1/issuers/truong-mau/credentials/${ID}/status`, { status: 'suspended' }, { authorization: 'Bearer some-portal-token-value-123' }],
  ['post', '/v1/auth/register/start', { phone: '+84900000777', device: { deviceId: 'test-outage', platform: 'ios' } }]
];

/** All probes at once; each answer with its status, body and time. */
async function probeAll() {
  return Promise.all(
    PROBES.map(async ([method, path, body, headers]) => {
      const started = Date.now();
      let req = http()[method](path).set('X-Forwarded-For', `198.51.100.${(ipSeq = (ipSeq % 250) + 1)}`);

      for (const [name, value] of Object.entries(headers ?? {})) req = req.set(name, value);

      const res = await (body === undefined ? req : req.send(body));

      return { route: `${method.toUpperCase()} ${path.split('/').slice(0, 4).join('/')}`, status: res.status, body: res.body, headers: res.headers, ms: Date.now() - started };
    })
  );
}

const byRoute = (results: Awaited<ReturnType<typeof probeAll>>) => Object.fromEntries(results.map((r) => [r.route, r.status]));

function assertNoSlow500(results: Awaited<ReturnType<typeof probeAll>>) {
  for (const r of results) {
    assert.notEqual(r.status, 500, `${r.route}: ${JSON.stringify(r.body)}`);
    // Bounded by the 1 s Redis command timeout and the status-list wait.
    assert.ok(r.ms < 2500, `${r.route} took ${r.ms} ms`);

    if (r.status === 503 && r.route.includes('/v1/') && !r.route.includes('/v1/auth/') && !r.route.includes('/v1/health')) {
      assert.equal(r.body.code, 'UNAVAILABLE', r.route);
      assert.ok(Number(r.headers['retry-after']) > 0, r.route);
    }
    if (r.status === 503 && !r.route.includes('/v1/')) assert.equal(r.body.error, 'temporarily_unavailable', r.route);
  }
}

describe('dependency outages (M4)', () => {
  it('Redis down: what needs Redis is 503 at once, the rest is served', async () => {
    const { n } = await app.get<StatusListService>(STATUS_LIST_SERVICE).allocate('truong-mau');

    assert.equal(n, 1);
    await redisProxy.stop();

    const results = await probeAll();

    assertNoSlow500(results);
    assert.deepEqual(byRoute(results), {
      'GET /v1/health': 503,
      'GET /trust-list': 200,
      'GET /issuers/truong-mau/status': 200,
      'GET /.well-known/openid-credential-issuer/issuers': 200,
      'GET /issuers/truong-mau/offers': 503,
      'POST /issuers/truong-mau/token': 503,
      'POST /issuers/truong-mau/nonce': 503,
      'POST /issuers/truong-mau/credential': 401,
      'POST /v1/demo/school': 503,
      'POST /v1/verification/sessions': 503,
      'GET /v1/verification/sessions': 503,
      'GET /oid4vp/request/AAAAAAAAAAAAAAAAAAAAAA': 503,
      'POST /oid4vp/response/AAAAAAAAAAAAAAAAAAAAAA': 503,
      'GET /v1/products/09520123456788': 404,
      'POST /v1/products/09520123456788': 503,
      'POST /v1/issuers/truong-mau': 503,
      'POST /v1/auth/register': 503
    });
    assert.equal(results[0]!.body.services.redis.status, 'down');

    await redisProxy.start();
    await new Promise<void>((resolve) => app.get(RedisService).getClient().once('ready', () => resolve()));
  });

  it('Postgres down: what needs Postgres is 503 at once; the status list falls back to the token it holds', async () => {
    const held = (await http().get('/issuers/truong-mau/status/1').expect(200)).text;

    await pg.stop();

    const results = await probeAll();

    assertNoSlow500(results);
    assert.deepEqual(byRoute(results), {
      'GET /v1/health': 503,
      'GET /trust-list': 200,
      'GET /issuers/truong-mau/status': 200,
      'GET /.well-known/openid-credential-issuer/issuers': 200,
      'GET /issuers/truong-mau/offers': 404,
      'POST /issuers/truong-mau/token': 400,
      'POST /issuers/truong-mau/nonce': 200,
      'POST /issuers/truong-mau/credential': 401,
      'POST /v1/demo/school': 503,
      'POST /v1/verification/sessions': 201,
      'GET /v1/verification/sessions': 404,
      'GET /oid4vp/request/AAAAAAAAAAAAAAAAAAAAAA': 404,
      'POST /oid4vp/response/AAAAAAAAAAAAAAAAAAAAAA': 400,
      'GET /v1/products/09520123456788': 503,
      'POST /v1/products/09520123456788': 401,
      // The portal session lives in Redis: an unknown token is still told so.
      'POST /v1/issuers/truong-mau': 401,
      'POST /v1/auth/register': 503
    });
    assert.equal(results[0]!.body.services.database.status, 'down');
    assert.equal((await http().get('/issuers/truong-mau/status/1').expect(200)).text, held);

    // Last in this file: Prisma's recovery after a real Postgres restart is its own (one failed
    // query per pooled connection, then it reconnects); a cut proxy does not model that well.
  });
});
