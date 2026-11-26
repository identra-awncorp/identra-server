// DPKI off (no CERTNET_* configuration, ADR-0020): the DID issuer truong-mau-certnet does not exist
// here, even with its rows and accounts left in the database, and health is as before.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import * as argon2 from 'argon2';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { StatusListService } from '@identra/sdk-server';
import request from 'supertest';

import { PORTAL_PASSWORD_HASH } from '../src/demo-portal/demo-accounts';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { VcCredentialsService } from '../src/vc/vc-credentials.service';
import { PKI, Pki, STATUS_LIST_SERVICE } from '../src/vc/vc.providers';
import { createTestApp, TEST_PORTAL_PASSWORD, testKeysDir } from './helpers';

const DID_ISSUER = 'truong-mau-certnet';
let app: NestExpressApplication;

before(async () => {
  app = await createTestApp({ IDENTRA_KEYS_DIR: testKeysDir() });
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());

describe('DPKI off', () => {
  it('the DID issuer is not hosted: its OpenID4VCI routes are 404', async () => {
    assert.deepEqual(app.get<Pki>(PKI).issuers.map((i) => i.name), ['truong-mau', 'nha-san-xuat', 'kiem-dinh', 'phan-phoi']);

    for (const path of [`/.well-known/openid-credential-issuer/issuers/${DID_ISSUER}`, `/.well-known/oauth-authorization-server/issuers/${DID_ISSUER}`, `/issuers/${DID_ISSUER}/jwks`, `/issuers/${DID_ISSUER}/offers/${'A'.repeat(22)}`]) {
      assert.equal((await http().get(path).expect(404)).body.error, 'not_found', path);
    }

    for (const path of ['nonce', 'token', 'credential']) await http().post(`/issuers/${DID_ISSUER}/${path}`).expect(404);
  });

  it('its status list is 404 even when a list of that name is stored, and no status change reaches it', async () => {
    // A list left by an earlier run with DPKI on (the underlying service creates it on allocation).
    await app.get<StatusListService>(STATUS_LIST_SERVICE).allocate(DID_ISSUER);
    await http().get(`/issuers/${DID_ISSUER}/status/1`).expect(404);

    const row = await app.get(PrismaService).vcIssuedCredential.create({
      data: { id: 'B'.repeat(22), issuerName: DID_ISSUER, vct: 'x', subjectRef: 'cn-sv001', statusListNumber: 1, statusIndex: 7, cnfThumbprint: 'x' }
    });

    // No API key or portal session can name it (env validation, sign-in); the service refuses it too.
    await assert.rejects(app.get(VcCredentialsService).changeStatus(DID_ISSUER, row.id, 'revoked'), (e: { getStatus(): number }) => e.getStatus() === 404);
  });

  it('an account of the DID issuer left in the database cannot sign in', async () => {
    const passwordHash = await argon2.hash(TEST_PORTAL_PASSWORD, PORTAL_PASSWORD_HASH);

    await app.get(PrismaService).demoPortalAccount.upsert({
      where: { username: 'cn-sv001' },
      create: { username: 'cn-sv001', passwordHash, role: 'student', issuerName: DID_ISSUER, profile: {} },
      update: { passwordHash, issuerName: DID_ISSUER }
    });

    for (const body of [{ username: 'cn-sv001' }, { username: 'cn-sv001', issuer: DID_ISSUER }]) {
      const res = await http().post('/v1/demo/school/login').set('X-Forwarded-For', '198.51.100.77').send({ ...body, password: TEST_PORTAL_PASSWORD }).expect(401);

      assert.equal(res.body.code, 'INVALID_CREDENTIALS');
    }
  });

  it('health is as before: no dpki member', async () => {
    const health = (await http().get('/v1/health').expect(200)).body;

    assert.deepEqual(Object.keys(health.services), ['database', 'redis', 'trustList', 'statusLists', 'verifier']);
    assert.equal(health.services.statusLists.status, 'up');
  });
});
