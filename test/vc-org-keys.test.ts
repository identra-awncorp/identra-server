// M3, N3: every hosted organisation's keys are checked at startup. Production refuses to start
// without them (naming the organisation and purpose, never key content); elsewhere the server
// starts, says so loudly, and that organisation's routes answer 503 (never 500, never a 200 for a
// change that cannot be published).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import type { StatusListService } from '@identra/sdk-server';

import { CLOCK, PKI, Pki, STATUS_LIST_SERVICE, vcProviders } from '../src/vc/vc.providers';
import { createTestApp, demoPkiDir } from './helpers';

const pki = demoPkiDir();
const work = mkdtempSync(join(tmpdir(), 'identra-org-keys-'));
const ORGS = ['truong-mau', 'nha-san-xuat', 'kiem-dinh', 'phan-phoi', 'nha-tuyen-dung-mau'];
const FILES = ['vc', 'vc-product', 'status', 'request'];
const kdKey = randomBytes(32).toString('base64url');

/**
 * A key directory like testKeysDir(): symlinks to the demo PKI's server part, except that the
 * organisations are copied (the key store opens key files without following symlinks) with only
 * the purposes `files(org)` lists (null: no directory at all); `rename` stores a purpose under
 * another file name. Removed with the work directory after the tests.
 */
function keysView(name: string, files: (org: string) => string[] | null, rename: Record<string, Record<string, string>> = {}) {
  const dir = join(work, name);

  mkdirSync(join(dir, 'orgs'), { recursive: true, mode: 0o700 });
  for (const f of ['trust-list-signer', 'root.cert.pem', 'trust-list.source.json']) symlinkSync(join(pki, f), join(dir, f));

  for (const org of ORGS) {
    const wanted = files(org);

    if (wanted === null) continue;
    mkdirSync(join(dir, 'orgs', org), { mode: 0o700 });

    for (const purpose of wanted.filter((p) => existsSync(join(pki, 'orgs', org, `${p}.key.pem`)))) {
      for (const ext of ['key.pem', 'chain.pem']) {
        const target = join(dir, 'orgs', org, `${rename[org]?.[purpose] ?? purpose}.${ext}`);

        copyFileSync(join(pki, 'orgs', org, `${purpose}.${ext}`), target);
        chmodSync(target, 0o600);
      }
    }
  }

  return dir;
}

const all = () => FILES;

/** The PKI provider alone, with `NODE_ENV` as given (startup check of vc.providers.ts). */
async function loadPki(dir: string, nodeEnv: string): Promise<Pki> {
  const env: Record<string, string> = { IDENTRA_KEYS_DIR: dir, IDENTRA_PUBLIC_BASE_URL: 'https://api-identra.awncorp.vn', NODE_ENV: nodeEnv };
  const config = { get: (k: string) => env[k], getOrThrow: (k: string) => env[k] };
  const providers = vcProviders.filter((p) => typeof p === 'object' && 'provide' in p && (p.provide === PKI || p.provide === CLOCK));
  const moduleRef = await Test.createTestingModule({ providers: [{ provide: ConfigService, useValue: config }, ...providers] }).compile();

  return moduleRef.get<Pki>(PKI);
}

const noKiemDinh = keysView('no-kiem-dinh', (org) => (org === 'kiem-dinh' ? null : all()));
const noRequestKey = keysView('no-request', (org) => (org === 'nha-tuyen-dung-mau' ? [] : all()));
// N3: the OpenID4VCI issuer with its certificate in the product issuers' file, and the reverse.
const swappedKinds = keysView('swapped', all, { 'truong-mau': { vc: 'vc-product' }, 'nha-san-xuat': { 'vc-product': 'vc' } });
const noKeyContent = (message: string) => !/BEGIN|PRIVATE KEY/.test(message);

describe('startup check of the hosted organisations (M3)', () => {
  it('production refuses to start without an organisation key, naming the organisation and purpose', async () => {
    await assert.rejects(loadPki(noKiemDinh, 'production'), (e: Error) => /kiem-dinh \(vc: .*; status: .*\)/.test(e.message) && noKeyContent(e.message));
    await assert.rejects(loadPki(noRequestKey, 'production'), (e: Error) => /nha-tuyen-dung-mau \(request: /.test(e.message) && noKeyContent(e.message));
  });

  it('production refuses an OpenID4VCI issuer signing from vc-product.* and a product issuer from vc.* (N3)', async () => {
    await assert.rejects(
      loadPki(swappedKinds, 'production'),
      (e: Error) => /truong-mau \(vc: a credential issuer signs with orgs\/truong-mau\/vc\.key\.pem/.test(e.message) && /nha-san-xuat \(vc: a product issuer/.test(e.message)
    );
  });

  it('outside production it starts and lists the organisations that cannot sign', async () => {
    const loaded = await loadPki(noKiemDinh, 'development');

    assert.deepEqual([...loaded.unavailable.keys()], ['kiem-dinh']);
    assert.ok((await loadPki(keysView('complete', all), 'production')).unavailable.size === 0);
  });
});

// The whole app, outside production: kiem-dinh has no keys, and the trust list lists truong-mau's
// vc certificate for product events only (N3).
const source = JSON.parse(readFileSync(join(pki, 'trust-list.source.json'), 'utf8'));
const tmIssuer = source.issuers.find((i: { ma_to_chuc: string }) => i.ma_to_chuc === 'VATVN-0100000001');
tmIssuer.vct = source.issuers.find((i: { ma_to_chuc: string }) => i.ma_to_chuc === 'VATVN-0100000002').vct;
const sourcePath = join(work, 'trust-list.source.json');
writeFileSync(sourcePath, JSON.stringify(source));

let app: NestExpressApplication;

before(async () => {
  app = await createTestApp({
    IDENTRA_KEYS_DIR: noKiemDinh,
    IDENTRA_TRUST_LIST_SOURCE: sourcePath,
    IDENTRA_ORG_API_KEY_HASHES: `kiem-dinh:${createHash('sha256').update(kdKey).digest('hex')}`
  });
});

after(async () => {
  await app?.close();
  rmSync(work, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());

describe('an organisation that cannot sign, outside production', () => {
  it('its status lists answer 503 (never 500) and health says statusLists down', async () => {
    const res = await http().get('/issuers/kiem-dinh/status/1').set('Origin', 'https://example.org').expect(503);

    assert.equal(res.body.error, 'temporarily_unavailable');
    assert.equal(res.headers['access-control-allow-origin'], '*');

    const health = (await http().get('/v1/health').expect(200)).body;

    assert.deepEqual(
      [health.services.statusLists.status, health.services.trustList.status, health.services.verifier.status],
      ['down', 'up', 'up']
    );
  });

  it('a status change it could never publish is 503, not 200', async () => {
    const res = await http()
      .post(`/v1/issuers/kiem-dinh/credentials/${randomBytes(16).toString('base64url')}/status`)
      .auth(kdKey, { type: 'bearer' })
      .send({ status: 'suspended' })
      .expect(503);

    assert.equal(res.body.code, 'UNAVAILABLE');
  });

  it('an OpenID4VCI issuer refused by the trust-list check answers 503 on its protocol routes (N3)', async () => {
    for (const path of ['/.well-known/openid-credential-issuer/issuers/truong-mau', '/issuers/truong-mau/jwks']) {
      const res = await http().get(path).expect(503);

      assert.equal(res.body.error, 'temporarily_unavailable', path);
    }

    await http().post('/issuers/truong-mau/nonce').expect(503);
  });

  it('the other organisations keep working', async () => {
    const { n } = await app.get<StatusListService>(STATUS_LIST_SERVICE).allocate('nha-san-xuat');

    await http().get(`/issuers/nha-san-xuat/status/${n}`).expect(200);
  });
});
