import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { verifyTrustListToken } from '@identra/sdk-core';
import { PKI, Pki } from '../src/vc/vc.providers';
import { createTestApp, testKeysDir } from './helpers';

// The source is a copy (public data, no keys): the demo PKI itself is read-only for tests.
const keysDir = testKeysDir();
const sourceText = readFileSync(join(keysDir, 'trust-list.source.json'), 'utf8');
const workDir = mkdtempSync(join(tmpdir(), 'identra-trust-list-'));
const sourcePath = join(workDir, 'trust-list.source.json');
let mtime = Date.now() / 1000;

// Each write gets a distinct mtime, so the server re-reads it however fast the test runs.
function writeSource(content: string) {
  writeFileSync(sourcePath, content);
  mtime += 10;
  utimesSync(sourcePath, mtime, mtime);
}

let app: NestExpressApplication;
let pki: Pki;

before(async () => {
  // The source file does not exist yet: the first request has nothing good to serve. The server
  // still starts (M1): its verifier waits, degraded, for a trust list that lists it.
  app = await createTestApp({ IDENTRA_KEYS_DIR: keysDir, IDENTRA_TRUST_LIST_SOURCE: sourcePath });
  pki = app.get(PKI);
});

after(async () => {
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());
let ipSeq = 0;
const createSession = () =>
  http()
    .post('/v1/verification/sessions')
    .set('X-Forwarded-For', `198.51.100.${(ipSeq += 1)}`)
    .send({ verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' });
const verifierHealth = async () => (await http().get('/v1/health')).body.services.verifier.status as string;
const verify = (token: string) =>
  verifyTrustListToken(token, { chainValidator: pki.chainValidator, verifier: pki.verifier, now: new Date() });

describe('GET /trust-list', () => {
  it('is 503 while no valid trust list was ever produced, and health says down', async () => {
    const res = await http().get('/trust-list').set('Origin', 'https://identra.awncorp.vn').expect(503);

    assert.equal(res.body.error, 'temporarily_unavailable');
    // L3: the error of a public resource is readable from any origin too.
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
    assert.equal(res.headers['access-control-expose-headers'], 'Date, Retry-After');
    assert.equal((await http().get('/v1/health')).body.services.trustList.status, 'down');
  });

  it('the server started anyway (M1): sessions answer 503 and health says verifier down', async () => {
    const created = await createSession().expect(503);

    assert.deepEqual([created.body.code, created.headers['retry-after']], ['UNAVAILABLE', '1']);
    assert.equal((await http().get('/v1/health')).body.services.verifier.status, 'down');
    // Everything else is up: sign-in does not depend on the trust list.
    await http().post('/v1/auth/register/start').set('X-Forwarded-For', '198.51.100.7').send({ phone: '+84900000123', device: { deviceId: 'test-m1', platform: 'ios' } }).expect(201);
  });

  let firstToken = '';

  it('serves a token that verifies against the pinned root with the five demo organisations', async () => {
    writeSource(sourceText);

    const res = await http().get('/trust-list').set('Origin', 'https://evil.example').expect(200);

    assert.equal(res.headers['content-type'], 'application/jwt');
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
    // Public signed resources: Date readable by pages, 1200 requests per minute (contract §2, §8).
    assert.match(res.headers['access-control-expose-headers'] ?? '', /\bDate\b/);
    assert.equal(res.headers['x-ratelimit-limit'], '1200');

    const verified = await verify(res.text);

    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;

    const purposes = Object.fromEntries(
      [...verified.payload.issuers, ...verified.payload.verifiers].map((e) => [
        e.ma_to_chuc,
        e.chung_thu.map((c) => c.muc_dich).sort().join('+')
      ])
    );

    assert.deepEqual(purposes, {
      'VATVN-0100000001': 'status+vc',
      'VATVN-0100000002': 'status+vc',
      'VATVN-0100000003': 'status+vc',
      'VATVN-0100000004': 'status+vc',
      'VATVN-0100000005': 'request'
    });
    assert.equal((await http().get('/v1/health')).body.services.trustList.status, 'up');
    firstToken = res.text;
  });

  it('re-signs with a later iat when the source file changes', async () => {
    const source = JSON.parse(sourceText);

    source.issuers[0].ten = 'Trường Mẫu Đổi Tên (DEMO)';
    writeSource(JSON.stringify(source));

    const res = await http().get('/trust-list').expect(200);
    const before = await verify(firstToken);
    const now = await verify(res.text);

    assert.notEqual(res.text, firstToken);
    assert.ok(before.ok && now.ok);
    assert.equal(now.payload.issuers[0]!.ten, 'Trường Mẫu Đổi Tên (DEMO)');
    assert.ok(now.payload.iat > before.payload.iat);
    firstToken = res.text;
  });

  it('notices an edit that keeps the mtime (cache keyed on mtime, ctime, size, inode)', async () => {
    const source = JSON.parse(sourceText);

    source.issuers[0].ten = 'Trường Mẫu Cùng Mtime (DEMO)';
    writeFileSync(sourcePath, JSON.stringify(source));
    utimesSync(sourcePath, mtime, mtime); // the same mtime as the previous write

    const res = await http().get('/trust-list').expect(200);
    const now = await verify(res.text);

    assert.ok(now.ok && now.payload.issuers[0]!.ten === 'Trường Mẫu Cùng Mtime (DEMO)');
    firstToken = res.text;
  });

  it('keeps serving the last good token when the source becomes invalid', async () => {
    for (const bad of ['{ not json', JSON.stringify({ issuers: [{ ma_to_chuc: 'x' }], verifiers: [] })]) {
      writeSource(bad);

      const res = await http().get('/trust-list').expect(200);

      assert.equal(res.text, firstToken);
    }

    assert.equal((await http().get('/v1/health')).body.services.trustList.status, 'up');
  });
});

describe('the hosted verifier follows the trust list (M1, L2)', () => {
  it('is built as soon as a trust list lists it, without waiting for a retry period', async () => {
    writeSource(sourceText);

    const created = await createSession().expect(201);

    assert.ok(created.body.id);
    assert.equal(await verifierHealth(), 'up');
  });

  it('a newly signed list without it stops session creation and health at once; listed again, both recover', async () => {
    const source = JSON.parse(sourceText);

    writeSource(JSON.stringify({ ...source, verifiers: [] }));
    // Health first: it reads the new token, so the verifier is rebuilt against it right away.
    assert.equal(await verifierHealth(), 'down');
    assert.equal((await createSession().expect(503)).body.code, 'UNAVAILABLE');

    writeSource(sourceText);
    await createSession().expect(201);
    assert.equal(await verifierHealth(), 'up');
  });
});
