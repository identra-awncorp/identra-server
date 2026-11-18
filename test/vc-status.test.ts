import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { statusListEntry, verifyStatusListToken, type StatusChecker, type TrustRegistry } from '@identra/sdk-core';
import type { StatusListService } from '@identra/sdk-server';
import { createPrismaStatusListStorage } from '../src/vc/status-storage';
import { VcCredentialsService } from '../src/vc/vc-credentials.service';
import { PKI, Pki, STATUS_CHECKER, STATUS_LIST_SERVICE, TRUST_REGISTRY } from '../src/vc/vc.providers';
import { createTestApp, portalLogin, randomIp, seedPortalAccounts, testKeysDir } from './helpers';

const ISSUER = 'truong-mau';
const ISSUER_ORG = 'VATVN-0100000001';
const OTHER_ORG = 'VATVN-0100000002';
const VCT = 'https://identra.awncorp.vn/vct/bang-tot-nghiep/v1';
const issuerKey = randomBytes(32).toString('base64url');
const otherOrgKey = randomBytes(32).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

let app: NestExpressApplication;
let prisma: PrismaService;
let credentials: VcCredentialsService;
let statusLists: StatusListService;
let checker: StatusChecker;
let registry: TrustRegistry;
let pki: Pki;

before(async () => {
  app = await createTestApp({
    IDENTRA_KEYS_DIR: testKeysDir(),
    IDENTRA_ORG_API_KEY_HASHES: `${ISSUER}:${sha256(issuerKey)},nha-san-xuat:${sha256(otherOrgKey)}`
  });
  prisma = app.get(PrismaService);
  credentials = app.get(VcCredentialsService);
  statusLists = app.get(STATUS_LIST_SERVICE);
  checker = app.get(STATUS_CHECKER);
  registry = app.get(TRUST_REGISTRY);
  pki = app.get(PKI);
  await seedPortalAccounts(prisma);
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());
const issue = (subjectRef = 'sv001') =>
  credentials.register({ issuerName: ISSUER, vct: VCT, subjectRef, cnfThumbprint: randomBytes(32).toString('base64url') });
const changeStatus = (id: string, status: string, token?: string, issuer = ISSUER) => {
  const req = http()
    .post(`/v1/issuers/${issuer}/credentials/${id}/status`)
    .set('X-Forwarded-For', randomIp())
    .send({ status });

  return token ? req.auth(token, { type: 'bearer' }) : req;
};
const listEntry = async (n: number, idx: number) => {
  const row = await prisma.vcStatusList.findUniqueOrThrow({ where: { issuerName_listNumber: { issuerName: ISSUER, listNumber: n } } });

  return statusListEntry(new Uint8Array(row.bytes), idx);
};

describe('GET /issuers/:name/status/:n', () => {
  it('serves a token that verifies for the issuer organisation and not for another', async () => {
    const issued = await issue();
    const res = await http().get('/issuers/truong-mau/status/1').expect(200);
    const uri = 'https://api-identra.awncorp.vn/issuers/truong-mau/status/1';
    const options = { uri, chainValidator: pki.chainValidator, trustRegistry: registry, verifier: pki.verifier, now: new Date() };

    assert.equal(issued.status.uri, uri);
    assert.equal(res.headers['content-type'], 'application/statuslist+jwt');
    assert.equal(res.headers['cache-control'], 'public, max-age=60');
    assert.equal(res.headers['access-control-allow-origin'], '*');

    const own = await verifyStatusListToken(res.text, { ...options, issuer: { maToChuc: ISSUER_ORG } });
    const other = await verifyStatusListToken(res.text, { ...options, issuer: { maToChuc: OTHER_ORG } });

    assert.equal(own.ok, true, JSON.stringify(own));
    assert.equal(other.ok, false);
    assert.equal(!other.ok && other.reason, 'not_trusted');
  });

  it('is 404 for an unknown issuer or list and for a malformed number', async () => {
    for (const path of ['khong-co/status/1', 'truong-mau/status/999', 'truong-mau/status/0', 'truong-mau/status/01', 'truong-mau/status/1234567890', 'Truong-Mau/status/1']) {
      const res = await http().get(`/issuers/${path}`).expect(404);

      assert.equal(res.body.error, 'not_found', path);
    }
  });

  it('is unprefixed, and the admin route is only under /v1', async () => {
    await http().get('/v1/issuers/truong-mau/status/1').expect(404);
    await http().get('/v1/trust-list').expect(404);
    await http().post('/issuers/truong-mau/credentials/x/status').send({ status: 'revoked' }).expect(404);
  });
});

describe('status-list storage on Postgres', () => {
  it('200 concurrent allocations get 200 different indexes', async () => {
    const results = await Promise.all(Array.from({ length: 200 }, () => statusLists.allocate(ISSUER)));
    const keys = new Set(results.map((r) => `${r.uri}#${r.idx}`));

    assert.equal(keys.size, 200);
  });

  it('reserve() is true for exactly one of 200 concurrent callers', async () => {
    const storage = createPrismaStatusListStorage(prisma);
    const idx = randomInt(0, 131072);
    const results = await Promise.all(Array.from({ length: 200 }, () => storage.reserve('race-test', 1, idx)));

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await storage.isReserved('race-test', 1, idx), true);
  });
});

describe('POST /v1/issuers/:name/credentials/:id/status', () => {
  it('authorises only the issuer API key and a registrar session of that issuer', async () => {
    const { id } = await issue();
    const student = await portalLogin(app, 'sv001');
    const registrar = await portalLogin(app, 'phongdaotao');
    const otherRegistrar = await portalLogin(app, 'phongqlcl-nsx');

    let res = await changeStatus(id, 'suspended').expect(401);
    assert.equal(res.body.code, 'SESSION_EXPIRED');
    res = await changeStatus(id, 'suspended', randomBytes(32).toString('base64url')).expect(401);
    assert.equal(res.body.code, 'SESSION_EXPIRED');
    res = await changeStatus(id, 'suspended', otherOrgKey).expect(403);
    assert.equal(res.body.code, 'FORBIDDEN');
    res = await changeStatus(id, 'suspended', student).expect(403);
    assert.equal(res.body.code, 'FORBIDDEN');
    res = await changeStatus(id, 'suspended', otherRegistrar).expect(403);
    assert.equal(res.body.code, 'FORBIDDEN');

    res = await changeStatus(id, 'suspended', issuerKey).expect(200);
    assert.equal(res.body.id, id);
    assert.equal(res.body.status, 'suspended');
    assert.ok(Date.parse(res.body.updatedAt));

    res = await changeStatus(id, 'valid', registrar).expect(200);
    assert.equal(res.body.status, 'valid');
  });

  it('keeps revoked final (409 CONFLICT) and is idempotent', async () => {
    const { id, status } = await issue();

    await changeStatus(id, 'revoked', issuerKey).expect(200);
    await changeStatus(id, 'revoked', issuerKey).expect(200);

    for (const next of ['valid', 'suspended']) {
      const res = await changeStatus(id, next, issuerKey).expect(409);

      assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'statusCode']);
      assert.equal(res.body.code, 'CONFLICT');
    }

    assert.equal(await listEntry(1, status.idx), 1, 'list value 1 = revoked');
  });

  it('answers 404 NOT_FOUND for an unknown or foreign credential and 400 for a bad status', async () => {
    const { id } = await issue();

    let res = await changeStatus(randomBytes(16).toString('base64url'), 'revoked', issuerKey).expect(404);
    assert.equal(res.body.code, 'NOT_FOUND');
    await changeStatus('not-an-id', 'revoked', issuerKey).expect(404);
    // The credential exists, but under another issuer, whose key this is.
    res = await changeStatus(id, 'revoked', otherOrgKey, 'nha-san-xuat').expect(404);
    assert.equal(res.body.code, 'NOT_FOUND');

    res = await changeStatus(id, 'deleted', issuerKey).expect(400);
    assert.equal(res.body.code, 'VALIDATION_FAILED');
    await changeStatus(id, 'revoked', issuerKey).send({ status: 'revoked', extra: 1 }).expect(400);
  });

  it('rolls back the list when the row update fails, and the row when the list update fails', async () => {
    const first = await issue();
    const second = await issue();

    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION identra_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`
    );

    try {
      // Second step fails: the row update.
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER identra_test_fail_row BEFORE UPDATE ON "VcIssuedCredential" FOR EACH ROW WHEN (OLD.id = '${first.id}') EXECUTE FUNCTION identra_test_fail()`
      );
      let res = await changeStatus(first.id, 'revoked', issuerKey).expect(500);
      assert.equal(res.body.code, 'INTERNAL_ERROR');
      assert.equal((await prisma.vcIssuedCredential.findUniqueOrThrow({ where: { id: first.id } })).status, 'valid');
      assert.equal(await listEntry(1, first.status.idx), 0, 'the list change must be rolled back');
      assert.equal(await checker.check(first.status, { maToChuc: ISSUER_ORG }), 'valid');

      // First step fails: the list update.
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER identra_test_fail_list BEFORE UPDATE ON "VcStatusList" FOR EACH ROW EXECUTE FUNCTION identra_test_fail()`
      );
      res = await changeStatus(second.id, 'revoked', issuerKey).expect(500);
      assert.equal((await prisma.vcIssuedCredential.findUniqueOrThrow({ where: { id: second.id } })).status, 'valid');
      assert.equal(await listEntry(1, second.status.idx), 0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS identra_test_fail_row ON "VcIssuedCredential"');
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS identra_test_fail_list ON "VcStatusList"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS identra_test_fail()');
    }

    // Once the failure is gone, the same change goes through.
    await changeStatus(first.id, 'revoked', issuerKey).expect(200);
    assert.equal(await listEntry(1, first.status.idx), 1);
  });
});

describe('recording an issuance (the issuer onIssued callback)', () => {
  it('is idempotent on offerId: a retried call returns the first row', async () => {
    const status = await statusLists.allocate(ISSUER);
    const event = {
      issuerName: ISSUER,
      vct: VCT,
      offerId: randomBytes(16).toString('base64url'),
      subjectRef: 'sv001',
      statusUri: status.uri,
      statusIdx: status.idx,
      cnfThumbprint: randomBytes(32).toString('base64url'),
      issuedAt: new Date()
    };
    const [first, second] = await Promise.all([credentials.recordIssued(event), credentials.recordIssued(event)]);

    assert.equal(first.credentialId, second.credentialId);
    assert.equal(await prisma.vcIssuedCredential.count({ where: { offerId: event.offerId } }), 1);
    await assert.rejects(credentials.recordIssued({ ...event, offerId: 'x'.repeat(22), statusUri: 'https://api-identra.awncorp.vn/issuers/kiem-dinh/status/1' }));
  });
});

describe('server-side status checker', () => {
  it('answers unavailable (STATUS_UNAVAILABLE) for a list on another host, without a socket', async () => {
    const connect = net.Socket.prototype.connect;
    let sockets = 0;

    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      sockets += 1;

      return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    } as typeof connect;

    try {
      for (const uri of ['https://issuer.example/issuers/truong-mau/status/1', 'https://api-identra.awncorp.vn.example/issuers/truong-mau/status/1']) {
        assert.equal(await checker.check({ uri, idx: 0 }, { maToChuc: ISSUER_ORG }), 'unavailable', uri);
      }
    } finally {
      net.Socket.prototype.connect = connect;
    }

    assert.equal(sockets, 0);
  });

  it('sees a revocation on the very next check, without any network', async () => {
    const { id, status } = await issue();
    const realFetch = globalThis.fetch;
    let networkCalls = 0;

    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error('no network in this test');
    }) as typeof fetch;

    try {
      assert.equal(await checker.check(status, { maToChuc: ISSUER_ORG }), 'valid');
      await changeStatus(id, 'revoked', issuerKey).expect(200);
      assert.equal(await checker.check(status, { maToChuc: ISSUER_ORG }), 'revoked');
      // The list is signed by truong-mau: checked as another organisation it is not usable.
      assert.equal(await checker.check(status, { maToChuc: OTHER_ORG }), 'unavailable');
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(networkCalls, 0);
  });
});
