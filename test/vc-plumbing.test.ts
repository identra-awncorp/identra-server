import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

import { Controller, Get, HttpException, NotFoundException, UseFilters } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { oauthError, ProtocolErrorFilter } from '../src/common/http-errors';
import { RateLimit } from '../src/common/rate-limit';
import { createRedisStateStore } from '../src/common/state-store';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { createOwnFetch } from '../src/vc/own-fetch';
import { createTestApp } from './helpers';

// Stand-in for the OpenID4VCI / OpenID4VP controllers of the next phase.
@Controller('oid4vp')
@UseFilters(ProtocolErrorFilter)
class ProbeProtocolController {
  @Get('request/grant')
  grant() {
    throw oauthError(400, 'invalid_grant', 'The pre-authorized code is invalid.');
  }

  @Get('request/missing')
  missing() {
    throw new NotFoundException('No such request.');
  }

  @Get('request/crash')
  crash() {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 secret-detail');
  }

  @Get('request/limited')
  @RateLimit('login')
  limited() {
    return { ok: true };
  }

  @Get('request/unavailable')
  unavailable() {
    throw new HttpException('down', 503);
  }
}

let app: NestExpressApplication;

before(async () => {
  app = await createTestApp({}, { controllers: [ProbeProtocolController] });
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());

describe('protocol error filter (OAuth 2.0 style)', () => {
  it('renders an OAuth error chosen by the controller', async () => {
    const res = await http().get('/oid4vp/request/grant').expect(400);

    assert.deepEqual(res.body, { error: 'invalid_grant', error_description: 'The pre-authorized code is invalid.' });
  });

  it('maps Nest exceptions to an OAuth-shaped body', async () => {
    const res = await http().get('/oid4vp/request/missing').expect(404);

    assert.deepEqual(res.body, { error: 'not_found', error_description: 'No such request.' });
  });

  it('turns unexpected errors into server_error without details or stack', async () => {
    const res = await http().get('/oid4vp/request/crash').expect(500);

    assert.deepEqual(res.body, { error: 'server_error' });
  });

  it('renders 503 as temporarily_unavailable', async () => {
    const res = await http().get('/oid4vp/request/unavailable').expect(503);

    assert.equal(res.body.error, 'temporarily_unavailable');
  });

  it('renders 429 as temporarily_unavailable with Retry-After', async () => {
    for (let i = 0; i < 10; i += 1) {
      await http().get('/oid4vp/request/limited').set('X-Forwarded-For', '203.0.113.90').expect(200);
    }

    const res = await http().get('/oid4vp/request/limited').set('X-Forwarded-For', '203.0.113.90').expect(429);

    assert.equal(res.body.error, 'temporarily_unavailable');
    assert.ok(Number(res.headers['retry-after']) > 0);
  });
});

describe('Redis state store', () => {
  it('take() hands a value to exactly one of 50 concurrent callers', async () => {
    const store = createRedisStateStore(app.get(RedisService).getClient(), 'test-take');

    await store.put('offer', 'secret-value', 60);

    const results = await Promise.all(Array.from({ length: 50 }, () => store.take('offer')));

    assert.equal(results.filter((value) => value === 'secret-value').length, 1);
    assert.equal(results.filter((value) => value === null).length, 49);
    assert.equal(await store.get('offer'), null);
  });

  it('namespaces keys, expires them, and counts with a TTL set once', async () => {
    const redis = app.get(RedisService).getClient();
    const a = createRedisStateStore(redis, 'test-a');
    const b = createRedisStateStore(redis, 'test-b');

    await a.put('k', 'from-a', 60);
    assert.equal(await b.get('k'), null);
    assert.ok((await redis.ttl('state:test-a:k')) > 0);

    assert.equal(await a.increment('attempts', 60), 1);
    await redis.expire('state:test-a:attempts', 30);
    assert.equal(await a.increment('attempts', 60), 2);
    assert.ok((await redis.ttl('state:test-a:attempts')) <= 30, 'a later increment must not extend the TTL');

    assert.throws(() => createRedisStateStore(redis, 'Bad Namespace'), TypeError);
  });
});

describe('own-origin fetch', () => {
  const ownFetch = createOwnFetch({
    baseUrl: 'https://api-identra.awncorp.vn',
    trustList: { token: async () => 'trust.list.token' },
    statusLists: {
      token: async (issuer: string, n: number) => (issuer === 'truong-mau' && n === 1 ? 'status.list.token' : null),
      allocate: async () => ({ uri: '', idx: 0 }),
      setStatus: async () => undefined,
      uri: () => ''
    }
  });

  it('answers the own trust list and status lists in-process', async () => {
    const trust = await ownFetch('https://api-identra.awncorp.vn/trust-list');
    const status = await ownFetch('https://api-identra.awncorp.vn/issuers/truong-mau/status/1');

    assert.equal(trust.status, 200);
    assert.equal(await trust.text(), 'trust.list.token');
    assert.equal(status.headers.get('Content-Type'), 'application/statuslist+jwt');
    assert.equal(await status.text(), 'status.list.token');
  });

  it('never sends other own-origin paths to the network', async () => {
    for (const url of [
      'https://api-identra.awncorp.vn/issuers/truong-mau/status/2',
      'https://api-identra.awncorp.vn/issuers/truong-mau/status/01',
      'https://api-identra.awncorp.vn/issuers/../status/1',
      'https://api-identra.awncorp.vn/trust-list?x=1',
      'https://api-identra.awncorp.vn/v1/health'
    ]) {
      assert.equal((await ownFetch(url)).status, 404, url);
    }
  });

  it('refuses every other origin without opening a socket', async () => {
    const connect = net.Socket.prototype.connect;
    let sockets = 0;

    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      sockets += 1;

      return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    } as typeof connect;

    try {
      for (const url of [
        'https://other.example/issuers/truong-mau/status/1',
        'http://api-identra.awncorp.vn/trust-list',
        'https://api-identra.awncorp.vn.evil.example/trust-list'
      ]) {
        await assert.rejects(ownFetch(url), /only from this server/, url);
      }
    } finally {
      net.Socket.prototype.connect = connect;
    }

    assert.equal(sockets, 0);
  });
});

describe('error shapes no controller filter sees (F11)', () => {
  it('/v1: malformed JSON is 400 VALIDATION_FAILED, an oversized body 413 PAYLOAD_TOO_LARGE', async () => {
    const malformed = await http().post('/v1/demo/school/login').set('Content-Type', 'application/json').send('{"username": ').expect(400);
    const large = await http()
      .post('/v1/demo/school/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ username: 'x'.repeat(70 * 1024), password: 'y' }))
      .expect(413);

    assert.deepEqual(malformed.body, { statusCode: 400, code: 'VALIDATION_FAILED', message: 'The request body is malformed.' });
    assert.deepEqual(large.body, { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' });
  });

  it('/v1: an unknown path is 404 NOT_FOUND in the envelope', async () => {
    const res = await http().get('/v1/no-such-route').expect(404);

    assert.equal(res.body.code, 'NOT_FOUND');
    assert.equal(res.body.statusCode, 404);
  });

  it('protocol paths: malformed or oversized bodies and unknown paths answer in the OAuth shape', async () => {
    const malformed = await http().post('/oid4vp/response/x').set('Content-Type', 'application/json').send('{').expect(400);
    const large = await http().post('/issuers/truong-mau/token').type('form').send(`a=${'x'.repeat(70 * 1024)}`).expect(413);
    const unknown = await http().get('/.well-known/no-such-thing').expect(404);

    assert.equal(malformed.body.error, 'invalid_request');
    assert.equal(large.body.error, 'invalid_request');
    assert.equal(unknown.body.error, 'not_found');
  });

  it('the auth routes keep their own shape', async () => {
    const res = await http().post('/v1/auth/login/start').send({}).expect(400);

    assert.ok(Array.isArray(res.body.message));
  });
});
