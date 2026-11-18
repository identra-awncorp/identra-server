import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Body, Controller, Get, Ip, Param, Post, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IsString } from 'class-validator';
import request from 'supertest';

import { createTestApp, randomDevice, randomPhone } from './helpers';

// Stand-ins for the future protocol controllers, to exercise configureApp().
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
  @Post()
  receive(@Body() body: unknown) {
    return { type: typeof body, body };
  }
}

let app: NestExpressApplication;

before(async () => {
  app = await createTestApp({}, [ProbeIssuerController, ProbeMetadataController, ProbeTrustListController]);
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());

describe('configureApp', () => {
  it('serves protocol paths without the /v1 prefix and keeps /v1 for the rest', async () => {
    await http().get('/.well-known/openid-credential-issuer/issuers/truong-mau').expect(200);
    await http().get('/v1/.well-known/openid-credential-issuer/issuers/truong-mau').expect(404);
    await http().post('/v1/issuers/truong-mau/token').type('form').send({ grant_type: 'x' }).expect(404);
    await http().get('/v1/auth/status').expect(200);
    await http().get('/auth/status').expect(404);
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
      .post('/trust-list')
      .set('Content-Type', 'application/jwt')
      .send('eyJhbGciOiJFUzI1NiJ9.e30.sig')
      .expect(201);

    assert.deepEqual(res.body, { type: 'string', body: 'eyJhbGciOiJFUzI1NiJ9.e30.sig' });
  });

  it('refuses bodies over 64kb with 413', async () => {
    await http()
      .post('/trust-list')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(70 * 1024) }))
      .expect(413);
  });

  it('trusts exactly one proxy hop for the client IP and hides x-powered-by', async () => {
    const res = await http()
      .get('/.well-known/openid-credential-issuer/issuers/x')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.7')
      .expect(200);

    assert.equal(res.body.ip, '203.0.113.7');
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('only answers CORS for configured origins', async () => {
    const allowed = await http().get('/v1/auth/status').set('Origin', 'http://localhost:3000');
    const other = await http().get('/v1/auth/status').set('Origin', 'https://evil.example');

    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });
});
