// DPKI on but truong-mau-certnet has no DID key yet (certnet:register not run): the existing rule
// for hosted organisations (vc.providers.ts). Production refuses to start, naming it; elsewhere the
// server starts, its routes answer 503 and health says so. The other organisations are unaffected.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { CLOCK, PKI, Pki, vcProviders } from '../src/vc/vc.providers';
import { GATEWAY, NETWORK } from './certnet-stub';
import { copiedKeysDir, createTestApp } from './helpers';

const DPKI_ENV = { CERTNET_GATEWAY_URL: GATEWAY, CERTNET_NETWORK: NETWORK };
// Without orgs/truong-mau-certnet, whatever a developer registered into the demo PKI.
const keys = copiedKeysDir(mkdtempSync(join(tmpdir(), 'identra-dpki-no-key-')));
let app: NestExpressApplication;

/** The PKI provider alone (as in vc-org-keys.test.ts), with DPKI configured. */
async function loadPki(nodeEnv: string): Promise<Pki> {
  const env: Record<string, string> = { IDENTRA_KEYS_DIR: keys, IDENTRA_PUBLIC_BASE_URL: 'https://api-identra.awncorp.vn', NODE_ENV: nodeEnv, ...DPKI_ENV };
  const config = { get: (k: string) => env[k], getOrThrow: (k: string) => env[k] };
  const providers = vcProviders.filter((p) => typeof p === 'object' && 'provide' in p && (p.provide === PKI || p.provide === CLOCK));
  const moduleRef = await Test.createTestingModule({ providers: [{ provide: ConfigService, useValue: config }, ...providers] }).compile();

  return moduleRef.get<Pki>(PKI);
}

before(async () => {
  app = await createTestApp({ IDENTRA_KEYS_DIR: keys, ...DPKI_ENV });
});

after(async () => {
  await app?.close();
  rmSync(keys, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());

describe('DPKI on, no DID key for truong-mau-certnet', () => {
  it('production refuses to start, naming the organisation and the missing files', async () => {
    await assert.rejects(loadPki('production'), (e: Error) => /truong-mau-certnet \(did: a DID issuer signs with orgs\/truong-mau-certnet\/did\.json and did\.key\.pem/.test(e.message));
  });

  it('outside production it is the only organisation that cannot sign', async () => {
    assert.deepEqual([...(await loadPki('development')).unavailable.keys()], ['truong-mau-certnet']);
  });

  it('its routes answer 503, health says dpki and statusLists down; truong-mau is unaffected', async () => {
    for (const path of ['/.well-known/openid-credential-issuer/issuers/truong-mau-certnet', '/issuers/truong-mau-certnet/jwks']) {
      assert.equal((await http().get(path).expect(503)).body.error, 'temporarily_unavailable', path);
    }

    await http().post('/issuers/truong-mau-certnet/nonce').expect(503);
    await http().get('/.well-known/openid-credential-issuer/issuers/truong-mau').expect(200);

    const health = (await http().get('/v1/health').expect(200)).body;

    assert.deepEqual([health.services.dpki, health.services.statusLists.status, health.services.trustList.status], [{ status: 'down', network: NETWORK }, 'down', 'up']);
  });
});
