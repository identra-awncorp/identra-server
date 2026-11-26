// The DID trust path (ADR-0020) end to end over real HTTP, against a stub CertNet gateway shaped
// like the contract (certnet-stub.ts): `npm run certnet:register` registers truong-mau-certnet's
// DID and recognition; that issuer issues a diploma through its portal to the SDK wallet; the hosted
// verifier accepts it on the DID path and follows the trust registry, the gateway's outages and the
// status list; portal sessions of the two schools never reach each other's credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { base64UrlDecode, createCertNetDidResolver, createCertNetTrustRegistry, createMappedFetch, isCertNetDid, utf8Decode, VCT } from '@identra/sdk-core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

import { CLOCK, PKI, Pki, vcProviders } from '../src/vc/vc.providers';
import { call, LOCAL, login, newOffer, newWallet, nodeFetch, ORIGIN, PORT } from './e2e-world';
import { GATEWAY, NETWORK, startStubGateway, StubGateway } from './certnet-stub';
import { copiedKeysDir, createTestApp, PROVISION_ENV, randomIp, TEST_PORTAL_PASSWORD, TEST_REGISTRAR_PASSWORD, uniqueIp } from './helpers';

const STUB_PORT = 47450;
const DID_ISSUER = 'truong-mau-certnet';
const DPKI_ENV = { CERTNET_GATEWAY_URL: GATEWAY, CERTNET_NETWORK: NETWORK, CERTNET_GATEWAY_LOCAL_URL: `http://127.0.0.1:${STUB_PORT}` };
const WRITE_TOKEN = 'test-write-token-0123456789';
const SCRIPT = join(__dirname, '../src/scripts/certnet-register.js');
const DID_CHECK_ORDER = [
  'structure', 'algorithm', 'did_resolution', 'signature', 'validity_time',
  'credential_type', 'issuer_trust', 'status', 'holder_binding', 'query'
];
const work = mkdtempSync(join(tmpdir(), 'identra-dpki-'));
const logs: string[] = [];
const capture = (message: unknown) => void logs.push(String(message));
const capturing = { log: capture, warn: capture, error: capture, debug: capture, verbose: capture };
let stub: StubGateway;
let app: NestExpressApplication;
let keys = '';
let firstRun: { code: number | null; out: string };

/** IDENTRA_KEYS_DIR with room for orgs/truong-mau-certnet, which certnet:register writes. */
const keysCopy = (name: string) => copiedKeysDir(join(work, name));

/** The real command, as an operator runs it (asynchronously: the stub gateway lives in this process). */
function register(env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...DPKI_ENV, ...env } });
  let out = '';

  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));

  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

const didFiles = (dir: string) => join(dir, 'orgs', DID_ISSUER);
const readDid = (dir: string) => JSON.parse(readFileSync(join(didFiles(dir), 'did.json'), 'utf8')) as { did: string; kid: string };
const did = () => readDid(keys).did;

before(async () => {
  stub = await startStubGateway(STUB_PORT);
  keys = keysCopy('main');
  firstRun = await register({ IDENTRA_KEYS_DIR: keys, CERTNET_WRITE_TOKEN: WRITE_TOKEN });
  app = await createTestApp({ IDENTRA_KEYS_DIR: keys, ...DPKI_ENV });
  app.useLogger(capturing);
  await app.listen(PORT, '127.0.0.1');
  execFileSync(process.execPath, [join(__dirname, '../src/scripts/demo-provision.js')], { env: { ...process.env, ...PROVISION_ENV }, stdio: 'pipe' });
});

after(async () => {
  await app?.close();
  await stub?.close();
  rmSync(work, { recursive: true, force: true });
});

describe('npm run certnet:register', () => {
  it('creates the key (mode 600) and did.json from the gateway answer, and the registry record; the write token is a bearer', () => {
    assert.equal(firstRun.code, 0, firstRun.out);

    const keyPath = join(didFiles(keys), 'did.key.pem');
    const { did: registered, kid } = readDid(keys);
    const publicJwk = createPublicKey(readFileSync(keyPath)).export({ format: 'jwk' });

    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    assert.ok(isCertNetDid(registered, 'local'));
    assert.equal(kid, `${registered}#key-1`);
    assert.deepEqual((stub.dids.get(registered)!.verificationMethod as Array<{ publicKeyJwk: unknown }>)[0]!.publicKeyJwk, { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y });
    assert.deepEqual(stub.trust.get(registered), { issuerDid: registered, recognition: 'recognized', scopes: ['education'], vcTypes: [VCT.diploma], accreditingBody: null });

    const writes = stub.requests.filter((r) => r.method === 'POST');

    assert.deepEqual(writes.map((r) => [r.path, r.authorization]), [['/v1/dids', `Bearer ${WRITE_TOKEN}`], ['/v1/trust-registry/issuers', `Bearer ${WRITE_TOKEN}`]]);
    assert.ok(!/PRIVATE KEY|BEGIN/.test(firstRun.out) && !firstRun.out.includes(WRITE_TOKEN), firstRun.out);
    assert.match(firstRun.out, /the trust registry says: recognised for diplomas/);
  });

  it('a second run changes nothing: same key, same DID, no new DID, "already registered" (409) is fine', async () => {
    const before = [readFileSync(join(didFiles(keys), 'did.key.pem')), readFileSync(join(didFiles(keys), 'did.json'))];
    const creates = stub.requests.filter((r) => r.path === '/v1/dids').length;
    const again = await register({ IDENTRA_KEYS_DIR: keys });

    assert.equal(again.code, 0, again.out);
    assert.deepEqual([readFileSync(join(didFiles(keys), 'did.key.pem')), readFileSync(join(didFiles(keys), 'did.json'))], before);
    assert.equal(stub.requests.filter((r) => r.path === '/v1/dids').length, creates);
    assert.match(again.out, /already registered/);
    assert.match(again.out, /already in the trust registry; the trust registry says: recognised for diplomas/);
  });

  it('writes no did.json when the returned document does not hold exactly our key in assertionMethod (exit 3), and never replaces the key', async (t) => {
    t.after(() => (stub.tamper = undefined));
    const other = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };
    type Created = { did: string; document: { verificationMethod: Array<Record<string, unknown>>; assertionMethod: string[] } };
    const tampers: Array<[string, (a: Created) => unknown]> = [
      ['another key', (a) => ({ ...a, document: { ...a.document, verificationMethod: [{ ...a.document.verificationMethod[0], publicKeyJwk: other }] } })],
      ['a second key', (a) => ({ ...a, document: { ...a.document, verificationMethod: [...a.document.verificationMethod, { id: `${a.did}#key-2`, type: 'JsonWebKey2020', controller: a.did, publicKeyJwk: other }] } })],
      ['not in assertionMethod', (a) => ({ ...a, document: { ...a.document, assertionMethod: [] } })],
      ['another key in assertionMethod', (a) => ({ ...a, document: { ...a.document, assertionMethod: [...a.document.assertionMethod, `${a.did}#key-2`] } })],
      ['another fragment', (a) => ({ ...a, document: { ...a.document, verificationMethod: [{ ...a.document.verificationMethod[0], id: `${a.did}#key-9` }] } })],
      ['another controller', (a) => ({ ...a, document: { ...a.document, verificationMethod: [{ ...a.document.verificationMethod[0], controller: 'did:certnet:local:other' }] } })],
      ['another document id', (a) => ({ ...a, document: { ...a.document, id: 'did:certnet:local:other' } })],
      ['another network', (a) => ({ ...a, did: a.did.replace(':local:', ':testnet:') })],
      ['no document', (a) => ({ did: a.did })]
    ];

    for (const [name, tamper] of tampers) {
      const dir = keysCopy(`tamper-${tampers.findIndex(([n]) => n === name)}`);

      stub.tamper = tamper as (a: Record<string, unknown>) => Record<string, unknown>;
      const r = await register({ IDENTRA_KEYS_DIR: dir }, 'did');

      assert.equal(r.code, 3, `${name}: ${r.out}`);
      assert.match(r.out, /does not hold exactly this key/, name);
      assert.ok(!existsSync(join(didFiles(dir), 'did.json')), name);
      assert.ok(existsSync(join(didFiles(dir), 'did.key.pem')), name);
    }

    // The same directory again, with an honest gateway: the key generated before is the one registered.
    const dir = join(work, 'tamper-0');
    const key = readFileSync(join(didFiles(dir), 'did.key.pem'));

    stub.tamper = undefined;
    assert.equal((await register({ IDENTRA_KEYS_DIR: dir }, 'did')).code, 0);
    assert.deepEqual(readFileSync(join(didFiles(dir), 'did.key.pem')), key);
    assert.deepEqual(
      (stub.dids.get(readDid(dir).did)!.verificationMethod as Array<{ publicKeyJwk: { x: string } }>)[0]!.publicKeyJwk.x,
      createPublicKey(key).export({ format: 'jwk' }).x
    );
  });

  it('clear refusals: gateway errors (exit 2), a did.json without its key or DPKI off (exit 1); nothing written', async (t) => {
    t.after(() => {
      stub.mode = 'ok';
      stub.createStatus = undefined;
    });
    const fresh = keysCopy('errors');
    const files = () => readdirSync(didFiles(fresh)).sort();

    for (const status of [401, 422, 500]) {
      stub.createStatus = status;
      const r = await register({ IDENTRA_KEYS_DIR: fresh }, 'did');

      assert.deepEqual([r.code, /POST \/v1\/dids answered HTTP \d{3}/.test(r.out)], [2, true], r.out);
    }

    stub.createStatus = 202;
    assert.equal((await register({ IDENTRA_KEYS_DIR: fresh }, 'did')).code, 2);
    stub.createStatus = undefined;

    stub.mode = 'reset';
    assert.match((await register({ IDENTRA_KEYS_DIR: fresh }, 'did')).out, /the gateway did not answer/);
    stub.mode = 'ok';
    assert.deepEqual(files(), ['did.key.pem']);

    // A DID registered elsewhere without its key here: never a new key for it.
    const orphan = keysCopy('orphan');

    mkdirSync(didFiles(orphan), { mode: 0o700 });
    writeFileSync(join(didFiles(orphan), 'did.json'), JSON.stringify(readDid(keys)));
    const r = await register({ IDENTRA_KEYS_DIR: orphan });

    assert.deepEqual([r.code, /did\.json exists without did\.key\.pem/.test(r.out)], [1, true], r.out);
    assert.ok(!existsSync(join(didFiles(orphan), 'did.key.pem')));

    const off = await register({ IDENTRA_KEYS_DIR: keysCopy('off'), CERTNET_GATEWAY_URL: '', CERTNET_NETWORK: '', CERTNET_GATEWAY_LOCAL_URL: '' });

    assert.deepEqual([off.code, /DPKI is not configured/.test(off.out)], [1, true], off.out);
    assert.equal((await register({ IDENTRA_KEYS_DIR: keys }, 'everything')).code, 1);
  });

  it('recognise is a step of its own: it needs only did.json and sends only the registry request', async () => {
    const body = { ...stub.trust.get(did())! };
    const dir = keysCopy('recognise');

    mkdirSync(didFiles(dir), { mode: 0o700 });
    writeFileSync(join(didFiles(dir), 'did.json'), JSON.stringify(readDid(keys)));
    stub.trust.delete(did());
    const seen = stub.requests.length;
    const r = await register({ IDENTRA_KEYS_DIR: dir }, 'recognise');

    assert.equal(r.code, 0, r.out);
    assert.deepEqual(stub.requests.slice(seen).map((q) => `${q.method} ${q.path.split('?')[0]}`), [
      'POST /v1/trust-registry/issuers',
      `GET /v1/trust-registry/issuers/${encodeURIComponent(did())}`
    ]);
    assert.ok(!existsSync(join(didFiles(dir), 'did.key.pem')));
    assert.deepEqual(stub.trust.get(did()), body);
  });
});

describe('start-up check of the DID issuer', () => {
  it('a did.json naming a DID of another network than CERTNET_NETWORK makes the issuer unable to sign', async () => {
    const dir = keysCopy('other-network');

    mkdirSync(didFiles(dir), { mode: 0o700 });
    copyFileSync(join(didFiles(keys), 'did.key.pem'), join(didFiles(dir), 'did.key.pem'));
    chmodSync(join(didFiles(dir), 'did.key.pem'), 0o600);
    writeFileSync(join(didFiles(dir), 'did.json'), JSON.stringify({ did: 'did:certnet:testnet:abc', kid: 'did:certnet:testnet:abc#key-1' }));

    // The PKI provider alone (as in vc-org-keys.test.ts).
    const env: Record<string, string> = { IDENTRA_KEYS_DIR: dir, IDENTRA_PUBLIC_BASE_URL: ORIGIN, NODE_ENV: 'development', ...DPKI_ENV };
    const config = { get: (k: string) => env[k], getOrThrow: (k: string) => env[k] };
    const providers = vcProviders.filter((p) => typeof p === 'object' && 'provide' in p && (p.provide === PKI || p.provide === CLOCK));
    const moduleRef = await Test.createTestingModule({ providers: [{ provide: ConfigService, useValue: config }, ...providers] }).compile();
    const unavailable = moduleRef.get<Pki>(PKI).unavailable;

    // A second testing module replaces the process logger: the app's capture again.
    app.useLogger(capturing);

    assert.deepEqual([...unavailable.keys()], [DID_ISSUER]);
    assert.match(unavailable.get(DID_ISSUER)!, /another network than CERTNET_NETWORK/);
  });
});

const createSession = async () => call('POST', '/v1/verification/sessions', { body: { verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' }, ip: uniqueIp() });
const session = async (id: string) => (await call('GET', `/v1/verification/sessions/${id}`)).body;
const codeAt = (checks: Array<{ id: string; code: string | null }>, id: string) => checks.find((c) => c.id === id)?.code;
const firstFailure = (checks: Array<{ id: string; ok: boolean; code: string | null }>) => checks.find((c) => !c.ok);

type Wallet = ReturnType<typeof newWallet>['wallet'];

/** One fresh session answered by `wallet` (claim set 2): the session, the submit outcome, the server's log line. */
async function present(wallet: Wallet, credentialId: string) {
  const created = await createSession();
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const resolved = await wallet.presentations.resolve(created.body.qr);
  assert.ok(resolved.ok, JSON.stringify(resolved));
  const submitted = await wallet.presentations.submit(resolved.request, { credentialId, claimSetIndex: 1 });
  const line = logs.find((l) => l.startsWith(`Presentation ${created.body.id.slice(0, 8)}:`));

  return { body: await session(created.body.id), submitted, line };
}

/** The wallet on the DID path: its own resolver and registry, reaching the stub for the gateway origin. */
const didWallet = () => {
  const fetch = createMappedFetch(nodeFetch, { [GATEWAY]: stub.url });

  return newWallet(undefined, (clock) => ({
    resolver: createCertNetDidResolver({ gatewayUrl: GATEWAY, network: NETWORK, fetch, clock }),
    trustRegistry: createCertNetTrustRegistry({ gatewayUrl: GATEWAY, network: NETWORK, fetch })
  }));
};

const portalLogin = async (username: string, issuer?: string) =>
  call('POST', '/v1/demo/school/login', {
    body: { ...(issuer ? { issuer } : {}), username, password: /phongdaotao$/.test(username) ? TEST_REGISTRAR_PASSWORD : TEST_PORTAL_PASSWORD },
    ip: randomIp()
  });
const didLogin = async (username: string) => {
  const res = await portalLogin(username, DID_ISSUER);

  assert.equal(res.status, 201, JSON.stringify(res.body));

  return res.body.token as string;
};

/** Through the portal of `token`'s school into `wallet`: the wallet's credential and the server's record id. */
async function issue(wallet: Wallet, token: string) {
  const offer = await newOffer(token);
  const resolved = await wallet.offers.resolve(offer.offerUri);
  assert.ok(resolved.ok, JSON.stringify(resolved));

  const accepted = await wallet.offers.accept(resolved.offer, { txCode: offer.txCode });
  assert.ok(accepted.ok, JSON.stringify(accepted));

  const listed = await call('GET', '/v1/demo/school/credentials', { token });

  return { accepted, offerId: offer.offerId, serverId: listed.body.items[0].id as string };
}

describe('the DID issuer truong-mau-certnet and the hosted verifier', () => {
  let holder: ReturnType<typeof newWallet>;
  let student = '';
  let credentialId = '';
  let serverId = '';

  it('publishes identra_issuer_did in its metadata; the OpenID4VCI identifier stays its https URL', async () => {
    const metadata = await call('GET', `/.well-known/openid-credential-issuer/issuers/${DID_ISSUER}`);

    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.identra_issuer_did, did());
    assert.equal(metadata.body.credential_issuer, `${ORIGIN}/issuers/${DID_ISSUER}`);
    assert.equal((await call('GET', '/.well-known/openid-credential-issuer/issuers/truong-mau')).body.identra_issuer_did, undefined);
  });

  it('issues a diploma through the portal (login with issuer) to the wallet, which verifies it on the DID path', async () => {
    holder = didWallet();
    student = await didLogin('cn-sv001');
    const issued = await issue(holder.wallet, student);

    credentialId = issued.accepted.ok ? issued.accepted.credentialId : '';
    serverId = issued.serverId;
    assert.ok(issued.accepted.ok);
    if (!issued.accepted.ok) return;
    assert.deepEqual([issued.accepted.issuerDid, issued.accepted.issuerName, issued.accepted.status], [did(), null, 'valid']);

    const [summary] = await holder.wallet.credentials.list();
    const details = await holder.wallet.credentials.get(credentialId);

    assert.deepEqual([summary?.trustPath, summary?.issuerDid, summary?.issuerUri], ['did', did(), `${ORIGIN}/issuers/${DID_ISSUER}`]);
    assert.equal(details.ok && details.credential.claims['ho_ten'], 'Nguyễn Thị Minh Anh');
    assert.equal((await call('GET', `/v1/demo/school/offers/${issued.offerId}`, { token: student })).body.status, 'issued');

    // Its status list is served like every issuer's, signed by the DID key (no x5c).
    const list = await fetch(`${LOCAL}/issuers/${DID_ISSUER}/status/1`);
    const [header, payload] = (await list.text()).split('.').slice(0, 2).map((part) => JSON.parse(utf8Decode(base64UrlDecode(part))));

    assert.equal(list.status, 200);
    assert.deepEqual([header.kid, 'x5c' in header, payload.sub], [`${did()}#key-1`, false, `${ORIGIN}/issuers/${DID_ISSUER}/status/1`]);
  });

  it('a gateway with no usable answer (503, connection dropped): refused at did_resolution, never accepted', async (t) => {
    t.after(() => (stub.mode = 'ok'));

    for (const mode of ['unavailable', 'reset'] as const) {
      stub.mode = mode;
      const { body, submitted, line } = await present(holder.wallet, credentialId);

      assert.equal(submitted.ok, false, mode);
      assert.notEqual(body.status, 'verified', mode);
      assert.equal(line?.endsWith('refused (DID_RESOLUTION_UNAVAILABLE)'), true, `${mode}: ${line}`);
    }
  });

  it('verified on the DID path: trustPath did, the issuer DID, no issuer name', async () => {
    const { body } = await present(holder.wallet, credentialId);

    assert.equal(body.status, 'verified', JSON.stringify(body));
    assert.deepEqual(body.result.checks.map((c: { id: string }) => c.id), DID_CHECK_ORDER);
    assert.ok(body.result.checks.every((c: { ok: boolean; code: string | null }) => c.ok && c.code === null));
    assert.deepEqual([body.result.trustPath, body.result.issuerDid, 'issuer' in body.result], ['did', did(), false]);
    assert.deepEqual(body.result.claims, { ho_ten: 'Nguyễn Thị Minh Anh', nganh: 'Công nghệ thông tin' });
  });

  it('the trust registry gives no answer: fails at issuer_trust with TRUST_LIST_UNAVAILABLE, never accepted', async (t) => {
    t.after(() => (stub.mode = 'ok'));
    stub.mode = 'trust-unavailable';
    const { body, submitted } = await present(holder.wallet, credentialId);

    assert.equal(submitted.ok, true);
    assert.equal(body.status, 'failed');
    assert.deepEqual(firstFailure(body.result.checks), { id: 'issuer_trust', ok: false, code: 'TRUST_LIST_UNAVAILABLE' });
    assert.deepEqual(['claims' in body.result, 'trustPath' in body.result, 'issuerDid' in body.result], [false, false, false]);
  });

  it('once the registry says rejected the next session fails exactly at issuer_trust (ISSUER_NOT_TRUSTED); recognised again, it verifies', async () => {
    const reject = await fetch(`${stub.url}/v1/trust-registry/issuers/${encodeURIComponent(did())}/reject`, { method: 'POST' });

    assert.equal(reject.status, 200);
    const { body } = await present(holder.wallet, credentialId);

    assert.equal(body.status, 'failed');
    assert.deepEqual(firstFailure(body.result.checks), { id: 'issuer_trust', ok: false, code: 'ISSUER_NOT_TRUSTED' });
    assert.ok(body.result.checks.slice(0, DID_CHECK_ORDER.indexOf('issuer_trust')).every((c: { ok: boolean }) => c.ok));
    assert.deepEqual(['trustPath' in body.result, 'issuerDid' in body.result], [false, false]);

    stub.trust.get(did())!.recognition = 'recognized';
    assert.equal((await present(holder.wallet, credentialId)).body.status, 'verified');
  });

  it('revoked by the student in the portal session that issued it: the next session fails at status', async () => {
    const revoked = await call('POST', `/v1/demo/school/credentials/${serverId}/revoke`, { token: student });

    assert.deepEqual([revoked.status, revoked.body.status], [200, 'revoked']);
    const { body } = await present(holder.wallet, credentialId);

    assert.equal(body.status, 'failed');
    assert.deepEqual(firstFailure(body.result.checks), { id: 'status', ok: false, code: 'REVOKED' });
  });

  it('a portal session of one school cannot list, read or revoke the other school\'s credentials or offers', async () => {
    const x509 = newWallet();
    const tmStudent = await login('sv001');
    const tmRegistrar = await login('phongdaotao');
    const cnStudent = await didLogin('cn-sv002');
    const cnRegistrar = await didLogin('cn-phongdaotao');
    const tm = await issue(x509.wallet, tmStudent);
    const cn = await issue(didWallet().wallet, cnStudent);
    const ids = async (token: string) => (await call('GET', '/v1/demo/school/credentials', { token })).body.items.map((i: { id: string }) => i.id) as string[];

    assert.ok(tm.accepted.ok && tm.accepted.issuerDid === undefined);
    assert.deepEqual(await ids(tmStudent), [tm.serverId]);
    assert.deepEqual(await ids(cnStudent), [cn.serverId]);
    assert.ok((await ids(tmRegistrar)).includes(tm.serverId) && !(await ids(tmRegistrar)).some((id) => [cn.serverId, serverId].includes(id)));
    assert.ok((await ids(cnRegistrar)).includes(cn.serverId) && (await ids(cnRegistrar)).includes(serverId) && !(await ids(cnRegistrar)).includes(tm.serverId));

    const status = (token: string, issuer: string, id: string) => call('POST', `/v1/issuers/${issuer}/credentials/${id}/status`, { token, body: { status: 'suspended' } });

    assert.equal((await call('POST', `/v1/demo/school/credentials/${tm.serverId}/revoke`, { token: cnStudent })).status, 404);
    assert.equal((await call('POST', `/v1/demo/school/credentials/${cn.serverId}/revoke`, { token: tmStudent })).status, 404);
    assert.equal((await call('GET', `/v1/demo/school/offers/${tm.offerId}`, { token: cnStudent })).status, 404);
    assert.equal((await call('DELETE', `/v1/demo/school/offers/${cn.offerId}`, { token: tmStudent })).status, 404);
    assert.equal((await status(cnRegistrar, 'truong-mau', tm.serverId)).status, 403);
    assert.equal((await status(cnRegistrar, DID_ISSUER, tm.serverId)).status, 404);
    assert.equal((await status(tmRegistrar, DID_ISSUER, cn.serverId)).status, 403);
    assert.deepEqual((await call('GET', '/v1/demo/school/credentials', { token: tmStudent })).body.items.map((i: { status: string }) => i.status), ['valid']);
    assert.deepEqual((await call('GET', '/v1/demo/school/credentials', { token: cnStudent })).body.items.map((i: { status: string }) => i.status), ['valid']);

    // The X.509 credential still verifies on its own path, with the trust-list name.
    const presented = await present(x509.wallet, tm.accepted.ok ? tm.accepted.credentialId : '');

    assert.deepEqual([presented.body.status, presented.body.result.trustPath, presented.body.result.issuer?.maToChuc], ['verified', 'x509', 'VATVN-0100000001']);
  });

  it('the issuer selector of the portal sign-in: an account of another school is unknown there', async () => {
    for (const [username, issuer] of [['cn-sv001', 'truong-mau'], ['sv001', DID_ISSUER], ['cn-phongdaotao', 'truong-mau'], ['sv001', 'khong-co']]) {
      const res = await portalLogin(username!, issuer);

      assert.deepEqual([res.status, res.body.code], [401, 'INVALID_CREDENTIALS'], `${username} at ${issuer}`);
    }

    assert.equal((await portalLogin('sv001', 'truong-mau')).status, 201);
    assert.equal((await portalLogin('cn-sv003')).status, 201);
    assert.deepEqual([(await portalLogin('sv001', 'Truong-Mau')).status, (await portalLogin('sv001', 'Truong-Mau')).body.code], [400, 'VALIDATION_FAILED']);
  });

  it('health says DPKI is configured and the DID issuer can sign, without asking the gateway', async () => {
    const seen = stub.requests.length;
    const health = (await call('GET', '/v1/health')).body;

    assert.deepEqual(health.services.dpki, { status: 'up', network: NETWORK });
    assert.equal(health.services.statusLists.status, 'up');
    assert.equal(stub.requests.length, seen);
  });
});
