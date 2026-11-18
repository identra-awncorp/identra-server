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
  // The source file does not exist yet: the first request has nothing good to serve.
  app = await createTestApp({ IDENTRA_KEYS_DIR: keysDir, IDENTRA_TRUST_LIST_SOURCE: sourcePath });
  pki = app.get(PKI);
});

after(async () => {
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());
const verify = (token: string) =>
  verifyTrustListToken(token, { chainValidator: pki.chainValidator, verifier: pki.verifier, now: new Date() });

describe('GET /trust-list', () => {
  it('is 503 while no valid trust list was ever produced, and health says down', async () => {
    const res = await http().get('/trust-list').expect(503);

    assert.equal(res.body.error, 'temporarily_unavailable');
    assert.equal((await http().get('/v1/health')).body.services.trustList.status, 'down');
  });

  let firstToken = '';

  it('serves a token that verifies against the pinned root with the five demo organisations', async () => {
    writeSource(sourceText);

    const res = await http().get('/trust-list').set('Origin', 'https://evil.example').expect(200);

    assert.equal(res.headers['content-type'], 'application/jwt');
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);

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

  it('keeps serving the last good token when the source becomes invalid', async () => {
    for (const bad of ['{ not json', JSON.stringify({ issuers: [{ ma_to_chuc: 'x' }], verifiers: [] })]) {
      writeSource(bad);

      const res = await http().get('/trust-list').expect(200);

      assert.equal(res.text, firstToken);
    }

    assert.equal((await http().get('/v1/health')).body.services.trustList.status, 'up');
  });
});
