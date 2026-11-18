import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Body, Controller, Get, Ip, Param, Post, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IsString } from 'class-validator';
import request from 'supertest';

import { createTestApp, randomDevice, randomPhone } from './helpers';

// Stand-ins for the future controllers of docs/vc-api.md, to exercise configureApp().
class TokenRequestDto {
  @IsString()
  grant_type: string;
}

@Controller('issuers')
class ProbeIssuerController {
  @Post(':name/token')
  token(
    @Param('name') name: string,
    // The documented opt-out: plain-object type (global pipe skips it) + own pipe.
    @Body(new ValidationPipe({ expectedType: TokenRequestDto, whitelist: false }))
    body: Record<string, unknown>
  ) {
    return { name, body };
  }

  @Post(':name/credential')
  credential(@Body() body: unknown) {
    return { type: typeof body, body };
  }

  // Admin API from docs/vc-api.md §3: must stay under /v1.
  @Post(':name/credentials/:credentialId/status')
  setStatus(@Param('credentialId') credentialId: string) {
    return { credentialId };
  }

  // A GET on a path that is only excluded for POST stays under /v1 too.
  @Get(':name/token')
  tokenInfo() {
    return { prefixed: true };
  }
}

@Controller('.well-known/openid-credential-issuer')
class ProbeMetadataController {
  @Get('issuers/:name')
  metadata(@Param('name') name: string, @Ip() ip: string) {
    return { name, ip };
  }
}

@Controller('trust-list')
class ProbeTrustListController {
  @Get()
  get() {
    return { ok: true };
  }
}

let app: NestExpressApplication;

before(async () => {
  app = await createTestApp({}, {
    controllers: [ProbeIssuerController, ProbeMetadataController, ProbeTrustListController]
  });
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());

describe('configureApp', () => {
  it('serves exactly the listed protocol routes without /v1', async () => {
    await http().get('/.well-known/openid-credential-issuer/issuers/truong-mau').expect(200);
    await http().get('/v1/.well-known/openid-credential-issuer/issuers/truong-mau').expect(404);
    await http().get('/trust-list').expect(200);
    await http().get('/v1/trust-list').expect(404);
    await http().post('/issuers/truong-mau/token').type('form').send({ grant_type: 'x' }).expect(201);
    await http().post('/v1/issuers/truong-mau/token').type('form').send({ grant_type: 'x' }).expect(404);
    await http().get('/v1/auth/status').expect(200);
    await http().get('/auth/status').expect(404);
  });

  it('keeps the admin status route and non-listed methods under /v1', async () => {
    const res = await http().post('/v1/issuers/truong-mau/credentials/c1/status').send({}).expect(201);

    assert.equal(res.body.credentialId, 'c1');
    await http().post('/issuers/truong-mau/credentials/c1/status').send({}).expect(404);
    await http().get('/v1/issuers/truong-mau/token').expect(200);
    await http().get('/issuers/truong-mau/token').expect(404);
  });

  it('parses OAuth form bodies and lets a protocol controller accept extra fields', async () => {
    const res = await http()
      .post('/issuers/truong-mau/token')
      .type('form')
      .send('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code&tx_code=1234')
      .expect(201);

    assert.deepEqual(res.body.body, {
      grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
      tx_code: '1234'
    });
    await http().post('/issuers/truong-mau/token').type('form').send('tx_code=1').expect(400);
  });

  it('keeps forbidNonWhitelisted on /v1 DTOs', async () => {
    await http()
      .post('/v1/auth/register/start')
      .send({ phone: randomPhone(), device: randomDevice(), extra: true })
      .expect(400);
  });

  it('reads application/jwt as raw text', async () => {
    const res = await http()
      .post('/issuers/truong-mau/credential')
      .set('Content-Type', 'application/jwt')
      .send('eyJhbGciOiJFQ0RILUVTIn0.e30.sig')
      .expect(201);

    assert.deepEqual(res.body, { type: 'string', body: 'eyJhbGciOiJFQ0RILUVTIn0.e30.sig' });
  });

  it('refuses bodies over 64kb with 413', async () => {
    await http()
      .post('/issuers/truong-mau/credential')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(70 * 1024) }))
      .expect(413);
  });

  it('takes the client IP from the single X-Forwarded-For value nginx writes', async () => {
    const res = await http()
      .get('/.well-known/openid-credential-issuer/issuers/x')
      .set('X-Forwarded-For', '203.0.113.7')
      .expect(200);

    assert.equal(res.body.ip, '203.0.113.7');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('ignores client-supplied X-Forwarded-For entries in front of the last hop', async () => {
    // A client sends "X-Forwarded-For: 6.6.6.6"; if a proxy appended instead of overwriting,
    // the app would see "6.6.6.6, <real>". One trusted hop means only <real> counts.
    const res = await http()
      .get('/.well-known/openid-credential-issuer/issuers/x')
      .set('X-Forwarded-For', '6.6.6.6, 1.2.3.4, 203.0.113.7')
      .expect(200);

    assert.equal(res.body.ip, '203.0.113.7');
  });

  it('only answers CORS for configured origins', async () => {
    const allowed = await http().get('/v1/auth/status').set('Origin', 'http://localhost:3000');
    const other = await http().get('/v1/auth/status').set('Origin', 'https://evil.example');

    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });

  it('serves Swagger outside production and advertises it on GET /v1', async () => {
    await http().get('/docs-json').expect(200);
    const info = await http().get('/v1').expect(200);

    assert.equal(info.body.docs, '/docs');
  });
});
