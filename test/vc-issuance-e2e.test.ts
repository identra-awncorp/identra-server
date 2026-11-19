// End to end over real HTTP: the Nest app listens on 127.0.0.1:47400; the WALLET is the SDK's
// own (@identra/sdk-app), reaching the canonical origin through createMappedFetch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { base64UrlEncode, utf8Encode } from '@identra/sdk-core';
import { createWebCryptoSigner, generateWebCryptoKeyPair } from '@identra/sdk-core/webcrypto';
import { NestExpressApplication } from '@nestjs/platform-express';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { ISSUER_CLOCK } from '../src/vc/vc.providers';
import { adjustableClock, call, ISS, issueDiplomaTo, keysDir, LOCAL, login, newOffer, newWallet, offerState, PORT, wrongPin } from './e2e-world';
import { createTestApp, TEST_PORTAL_PASSWORD } from './helpers';

const issuerClock = adjustableClock();
let app: NestExpressApplication;

before(async () => {
  app = await createTestApp(
    { IDENTRA_KEYS_DIR: keysDir },
    { override: (builder) => builder.overrideProvider(ISSUER_CLOCK).useValue(issuerClock) }
  );
  await app.listen(PORT, '127.0.0.1');
  // The real provisioning command, as an operator runs it.
  execFileSync(process.execPath, [join(__dirname, '../src/scripts/demo-provision.js')], {
    env: { ...process.env, DEMO_PORTAL_PASSWORD: TEST_PORTAL_PASSWORD },
    stdio: 'pipe'
  });
});

after(async () => {
  await app?.close();
});

const evidence = { name: 'Nguyễn Thị Minh Anh', diplomaNumber: 'TMDEMO-2025-000317', pins: [] as string[], compacts: [] as string[] };

describe('issue a diploma to the SDK wallet, then revoke it', () => {
  it('runs portal → offer → wallet → status → revocation', async () => {
    const student = await login('sv001');
    const registrar = await login('phongdaotao');
    const offer = await newOffer(student);

    evidence.pins.push(offer.txCode);
    // The URL is percent-encoded as a query value (the contract's §4 shows it unencoded).
    assert.equal(offer.offerUri, `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(`${ISS}/offers/${offer.offerId}`)}`);
    assert.match(offer.offerId, /^[A-Za-z0-9_-]{22}$/);
    assert.match(offer.txCode, /^[0-9]{6}$/);
    assert.equal(Date.parse(offer.expiresAt) - Date.parse(offer.serverTime) > 590_000, true);
    assert.equal((await offerState(student, offer.offerId)).body.status, 'pending');

    const { wallet, clock } = newWallet();
    const resolved = await wallet.offers.resolve(offer.offerUri);
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    if (!resolved.ok) return;

    const wrong = await wallet.offers.accept(resolved.offer, { txCode: wrongPin(offer.txCode) });
    assert.deepEqual([wrong.ok, !wrong.ok && wrong.code], [false, 'TX_CODE_WRONG']);

    const accepted = await wallet.offers.accept(resolved.offer, { txCode: offer.txCode });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    if (!accepted.ok) return;

    const [held] = await wallet.credentials.list();
    const details = await wallet.credentials.get(accepted.credentialId);
    assert.equal(held?.issuerUri, ISS);
    assert.equal(details.ok && details.credential.claims['ho_ten'], evidence.name);
    assert.equal(details.ok && details.credential.claims['so_hieu_bang'], evidence.diplomaNumber);

    const state = await offerState(student, offer.offerId);
    assert.deepEqual([state.status, state.body.status], [200, 'issued']);

    const listing = await call('GET', '/v1/demo/school/credentials', { token: registrar });
    const row = listing.body.items.find((i: { studentCode: string }) => i.studentCode === 'DEMO21CNTT0042');
    assert.equal(row?.status, 'valid');
    assert.equal(row?.studentName, evidence.name);

    const fresh = await wallet.credentials.refreshStatus(accepted.credentialId);
    assert.equal(fresh.ok && fresh.status, 'valid');

    const revoke = await call('POST', `/v1/issuers/truong-mau/credentials/${row.id}/status`, { token: registrar, body: { status: 'revoked' } });
    assert.deepEqual([revoke.status, revoke.body.status], [200, 'revoked']);

    // The wallet may keep a status list for 15 minutes (ADR-0019); past that it must reload.
    clock.advance(901);
    const afterRevoke = await wallet.credentials.refreshStatus(accepted.credentialId);
    assert.equal(afterRevoke.ok && afterRevoke.status, 'revoked');
    assert.equal((await call('GET', '/v1/demo/school/credentials', { token: student })).body.items[0].status, 'revoked');
  });
});

describe('negative paths over real HTTP', () => {
  it('five wrong PINs destroy the offer', async () => {
    const student = await login('sv002');
    const offer = await newOffer(student);
    const { wallet } = newWallet();
    const resolved = await wallet.offers.resolve(offer.offerUri);

    evidence.pins.push(offer.txCode);
    assert.ok(resolved.ok);
    if (!resolved.ok) return;

    const codes: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      const r = await wallet.offers.accept(resolved.offer, { txCode: wrongPin(offer.txCode) });

      codes.push(r.ok ? 'ok' : r.code);
    }

    assert.deepEqual(codes, ['TX_CODE_WRONG', 'TX_CODE_WRONG', 'TX_CODE_WRONG', 'TX_CODE_WRONG', 'OFFER_EXPIRED']);
    const right = await wallet.offers.accept(resolved.offer, { txCode: offer.txCode });
    assert.equal(!right.ok && right.code, 'OFFER_EXPIRED');
    assert.equal((await offerState(student, offer.offerId)).body.status, 'expired');
  });

  it('an offer older than 10 minutes is expired', async (t) => {
    t.after(() => issuerClock.reset());
    const student = await login('sv003');
    const offer = await newOffer(student);
    const { wallet } = newWallet();

    evidence.pins.push(offer.txCode);
    issuerClock.advance(601);
    const resolved = await wallet.offers.resolve(offer.offerUri);

    assert.equal(!resolved.ok && resolved.code, 'OFFER_EXPIRED');
    assert.equal((await offerState(student, offer.offerId)).body.status, 'expired');
  });

  it('only the owner can poll an offer; a new offer supersedes the pending one', async () => {
    const owner = await login('sv001');
    const first = await newOffer(owner);
    const second = await newOffer(owner);

    for (const token of [await login('sv002'), await login('phongdaotao')]) {
      const res = await offerState(token, second.offerId);

      assert.deepEqual([res.status, res.body.code], [404, 'NOT_FOUND']);
    }

    assert.equal((await offerState(owner, 'A'.repeat(22))).status, 404);
    assert.equal((await offerState(owner, first.offerId)).body.status, 'expired');
    assert.equal((await offerState(owner, second.offerId)).body.status, 'pending');
    assert.equal((await fetch(`${LOCAL}/issuers/truong-mau/offers/${first.offerId}`)).status, 404);
    assert.equal((await call('POST', '/v1/demo/school/offers', { token: await login('phongdaotao') })).status, 403);
    evidence.pins.push(first.txCode, second.txCode);
  });

  it('a pre-authorized code and an access token are single use', async () => {
    const offer = await newOffer(await login('sv001'));
    const offerJson = await (await fetch(`${LOCAL}/issuers/truong-mau/offers/${offer.offerId}`)).json();
    const code = offerJson.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']['pre-authorized_code'];
    const form = (txCode: string) =>
      new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code', 'pre-authorized_code': code, tx_code: txCode }).toString();
    const tokenRequest = (txCode: string) =>
      fetch(`${LOCAL}/issuers/truong-mau/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(txCode) });

    evidence.pins.push(offer.txCode);
    const first = await tokenRequest(offer.txCode);
    const { access_token: accessToken } = await first.json();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');

    const reuse = await tokenRequest(offer.txCode);
    assert.deepEqual([reuse.status, (await reuse.json()).error], [400, 'invalid_grant']);

    // A plain JSON credential request with a fresh proof, twice with the same access token.
    const holder = await createWebCryptoSigner(await generateWebCryptoKeyPair());
    const b64 = (v: unknown) => base64UrlEncode(utf8Encode(JSON.stringify(v)));
    const credentialRequest = async () => {
      const { c_nonce: nonce } = await (await fetch(`${LOCAL}/issuers/truong-mau/nonce`, { method: 'POST' })).json();
      const input = `${b64({ typ: 'openid4vci-proof+jwt', alg: 'ES256', jwk: holder.publicJwk })}.${b64({ aud: ISS, iat: Math.floor(Date.now() / 1000), nonce })}`;
      const proof = `${input}.${base64UrlEncode(await holder.sign(utf8Encode(input)))}`;

      return fetch(`${LOCAL}/issuers/truong-mau/credential`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ credential_configuration_id: 'bang-tot-nghiep-v1', proofs: { jwt: [proof] } })
      });
    };

    const issued = await credentialRequest();
    const issuedBody = await issued.json();
    assert.equal(issued.status, 200, JSON.stringify(issuedBody));
    evidence.compacts.push(issuedBody.credentials[0].credential);

    const again = await credentialRequest();
    assert.deepEqual([again.status, (await again.json()).error], [401, 'invalid_token']);
  });

  it('limits the token endpoint to 120 per minute per IP (N5), in OAuth shape with Retry-After and a fixed message', async () => {
    const ip = '203.0.113.150';
    const attempt = () =>
      fetch(`${LOCAL}/issuers/truong-mau/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
        body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code&pre-authorized_code=x&tx_code=1'
      });

    for (let i = 0; i < 120; i += 1) assert.equal((await attempt()).status, 400);

    const limited = await attempt();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'temporarily_unavailable', error_description: 'Too many requests; try again later.' });
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });

  it('hands the SDK the raw form body (a repeated parameter is still visible to it)', async () => {
    const res = await fetch(`${LOCAL}/issuers/truong-mau/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.151' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code&pre-authorized_code=x&tx_code=1&tx_code=2'
    });

    assert.deepEqual(await res.json(), { error: 'invalid_request', error_description: 'a parameter is repeated' });
  });

  it('an offer redeemed but never collected reads expired once its access token would have expired (L5)', async (t) => {
    t.after(() => issuerClock.reset());
    const student = await login('sv002');
    const offer = await newOffer(student);
    const offerJson = await (await fetch(`${LOCAL}/issuers/truong-mau/offers/${offer.offerId}`)).json();
    const code = offerJson.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']['pre-authorized_code'];
    const redeemed = await fetch(`${LOCAL}/issuers/truong-mau/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.152' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code', 'pre-authorized_code': code, tx_code: offer.txCode }).toString()
    });

    evidence.pins.push(offer.txCode);
    assert.equal(redeemed.status, 200);
    // The wallet is between token and credential: still pending.
    const polled = await offerState(student, offer.offerId);
    assert.equal(polled.body.status, 'pending');
    // L7: no portal answer is ever cached (they carry tokens, PINs and personal data), errors included.
    assert.equal(polled.headers.get('cache-control'), 'no-store');
    assert.equal((await call('POST', '/v1/demo/school/login', { body: { username: 'sv002', password: 'x' } })).headers.get('cache-control'), 'no-store');
    issuerClock.advance(299);
    assert.equal((await offerState(student, offer.offerId)).body.status, 'pending');
    issuerClock.advance(2);
    assert.equal((await offerState(student, offer.offerId)).body.status, 'expired');
  });

  it('product issuers have no OpenID4VCI endpoints: every route answers 404 in the OAuth shape (N3)', async () => {
    for (const name of ['nha-san-xuat', 'kiem-dinh', 'phan-phoi']) {
      for (const [method, path] of [
        ['GET', `/.well-known/openid-credential-issuer/issuers/${name}`],
        ['GET', `/.well-known/oauth-authorization-server/issuers/${name}`],
        ['GET', `/issuers/${name}/jwks`],
        ['GET', `/issuers/${name}/offers/${'A'.repeat(22)}`],
        ['POST', `/issuers/${name}/token`],
        ['POST', `/issuers/${name}/nonce`],
        ['POST', `/issuers/${name}/credential`]
      ] as const) {
        const res = await fetch(`${LOCAL}${path}`, { method, headers: { 'x-forwarded-for': '203.0.113.153' } });

        assert.deepEqual([res.status, (await res.json()).error], [404, 'not_found'], `${method} ${path}`);
      }
    }
  });

  it('answers unknown issuers with 404 in the OAuth shape', async () => {
    for (const path of ['/.well-known/openid-credential-issuer/issuers/khong-co', '/issuers/khong-co/jwks']) {
      const res = await fetch(`${LOCAL}${path}`);

      assert.deepEqual([res.status, (await res.json()).error], [404, 'not_found']);
    }
  });
});

describe('no personal data at rest', () => {
  it('stores no claim value, credential or PIN in the issuer tables or in Redis', async () => {
    const prisma = app.get(PrismaService);
    const redis = app.get(RedisService).getClient();
    const needles = [evidence.name, evidence.diplomaNumber, ...evidence.pins, ...evidence.compacts];
    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'json', 'jsonb', 'USER-DEFINED')`;
    const hits: string[] = [];

    for (const { table_name: table, column_name: column } of columns) {
      for (const needle of needles) {
        const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "${table}" WHERE position($1 in "${column}"::text) > 0`,
          needle
        );

        if (n > 0n) hits.push(`${table}.${column}`);
      }
    }

    // Only the school's own record holds the student's data: it is the source of the claims.
    assert.deepEqual([...new Set(hits)].sort(), ['DemoPortalAccount.profile']);
    assert.ok(evidence.pins.length >= 5 && evidence.compacts.length === 1);
    assert.ok((await prisma.vcIssuedCredential.count({ where: { offerId: { not: null } } })) >= 2);

    const keys = await redis.keys('*');
    let redisHits = 0;

    for (const key of keys) {
      const value = (await redis.type(key)) === 'string' ? ((await redis.get(key)) ?? '') : '';

      redisHits += needles.filter((needle) => key.includes(needle) || value.includes(needle)).length;
    }

    assert.equal(redisHits, 0);
    console.log(
      `no-PII-at-rest: ${columns.length} text/json columns x ${needles.length} needles, hits only in DemoPortalAccount.profile; ` +
        `${keys.length} Redis keys, 0 hits`
    );
  });
});

describe('a restart ends every pending offer (L1)', () => {
  it('the portal reads expired and the wallet gets OFFER_EXPIRED instead of burning PIN attempts', async () => {
    const student = await login('sv003');
    const offer = await newOffer(student);
    const early = newWallet();
    const resolved = await early.wallet.offers.resolve(offer.offerUri);

    evidence.pins.push(offer.txCode);
    assert.ok(resolved.ok);
    if (!resolved.ok) return;
    assert.equal((await offerState(student, offer.offerId)).body.status, 'pending');

    // The PIN key lived only in the old process.
    await app.close();
    app = await createTestApp({ IDENTRA_KEYS_DIR: keysDir }, { override: (builder) => builder.overrideProvider(ISSUER_CLOCK).useValue(issuerClock) });
    await app.listen(PORT, '127.0.0.1');

    assert.equal((await offerState(student, offer.offerId)).body.status, 'expired');
    const accepted = await early.wallet.offers.accept(resolved.offer, { txCode: offer.txCode });
    assert.equal(!accepted.ok && accepted.code, 'OFFER_EXPIRED');
    const late = await newWallet().wallet.offers.resolve(offer.offerUri);
    assert.equal(!late.ok && late.code, 'OFFER_EXPIRED');

    // A new offer after the restart works as usual.
    assert.ok(await issueDiplomaTo(newWallet().wallet, 'sv003'));
  });
});
