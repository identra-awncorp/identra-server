// End to end over real HTTP: a diploma issued to the SDK wallet is presented to the hosted
// verifier `nha-tuyen-dung-mau` (docs/vc-api.md §6), then suspended, restored and revoked.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { base64UrlDecode, utf8Decode, utf8Encode } from '@identra/sdk-core';
import { webCryptoRandom } from '@identra/sdk-core/webcrypto';
import { encryptJwe } from '@identra/sdk-app';
import { NestExpressApplication } from '@nestjs/platform-express';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { VERIFIER_CLOCK } from '../src/vc/verifiers';
import { adjustableClock, call, issueDiplomaTo, keysDir, LOCAL, login, newWallet, PORT } from './e2e-world';
import { createTestApp, demoPkiDir, TEST_PORTAL_PASSWORD } from './helpers';

const verifierClock = adjustableClock();
const logs: string[] = [];
let app: NestExpressApplication;

// Display names come from the trust list (its source file), never from the test.
const trustSource = JSON.parse(readFileSync(join(keysDir, 'trust-list.source.json'), 'utf8')) as {
  issuers: Array<{ ma_to_chuc: string; ten: string }>;
  verifiers: Array<{ ma_to_chuc: string; ten: string }>;
};
const tenOf = (maToChuc: string) => [...trustSource.issuers, ...trustSource.verifiers].find((e) => e.ma_to_chuc === maToChuc)!.ten;
const NAME = 'Nguyễn Thị Minh Anh';
const MAJOR = 'Công nghệ thông tin';
const DIPLOMA_NUMBER = 'TMDEMO-2025-000317';
const CHECK_ORDER = [
  'structure', 'algorithm', 'certificate_chain', 'signature', 'validity_time',
  'credential_type', 'issuer_trust', 'status', 'holder_binding', 'query'
];

before(async () => {
  app = await createTestApp({ IDENTRA_KEYS_DIR: keysDir }, { override: (builder) => builder.overrideProvider(VERIFIER_CLOCK).useValue(verifierClock) });
  // Capture what the server logs, to show that no claim value reaches a log line.
  const capture = (message: unknown) => void logs.push(String(message));
  app.useLogger({ log: capture, warn: capture, error: capture, debug: capture, verbose: capture });
  await app.listen(PORT, '127.0.0.1');
  execFileSync(process.execPath, [join(__dirname, '../src/scripts/demo-provision.js')], {
    env: { ...process.env, DEMO_PORTAL_PASSWORD: TEST_PORTAL_PASSWORD },
    stdio: 'pipe'
  });
});

after(async () => {
  await app?.close();
});

const createSession = async (ip?: string) =>
  call('POST', '/v1/verification/sessions', { body: { verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen' }, ip });
const session = async (id: string) => call('GET', `/v1/verification/sessions/${id}`);
const requestIdOf = (qr: string) => new URL(new URLSearchParams(qr.split('?')[1]).get('request_uri')!).pathname.split('/').pop()!;
const codeAt = (checks: Array<{ id: string; code: string | null }>, id: string) => checks.find((c) => c.id === id)?.code;

/** One fresh session, resolved and answered by `wallet` with claim set 2. */
async function present(wallet: ReturnType<typeof newWallet>['wallet'], credentialId: string) {
  const created = await createSession();
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const resolved = await wallet.presentations.resolve(created.body.qr);
  assert.ok(resolved.ok, JSON.stringify(resolved));
  assert.deepEqual(await wallet.presentations.submit(resolved.request, { credentialId, claimSetIndex: 1 }), { ok: true });

  return (await session(created.body.id)).body;
}

let holder: ReturnType<typeof newWallet>;
let credentialId = '';
let serverCredentialId = '';
let verifiedSessionId = '';

describe('present a diploma, then suspend, restore and revoke it', () => {
  it('verifies claim set 2 with every check in order, then follows the status on the very next session', async () => {
    holder = newWallet();
    credentialId = await issueDiplomaTo(holder.wallet);
    const registrar = await login('phongdaotao');
    serverCredentialId = (await call('GET', '/v1/demo/school/credentials', { token: registrar })).body.items[0].id;

    const created = await createSession();
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.body).sort(), ['expiresAt', 'id', 'qr', 'serverTime']);
    assert.match(created.body.qr, /^openid4vp:\/\/\?client_id=x509_hash%3A[A-Za-z0-9_-]{43}&request_uri=/);
    assert.equal((await session(created.body.id)).body.status, 'pending');

    const resolved = await holder.wallet.presentations.resolve(created.body.qr);
    assert.ok(resolved.ok, JSON.stringify(resolved));
    if (!resolved.ok) return;
    assert.equal(resolved.request.verifier.trusted, true);
    assert.equal(resolved.request.verifier.trusted && resolved.request.verifier.ten, tenOf('VATVN-0100000005'));
    assert.equal((await session(created.body.id)).body.status, 'request_retrieved');

    assert.deepEqual(await holder.wallet.presentations.submit(resolved.request, { credentialId, claimSetIndex: 1 }), { ok: true });
    const done = await session(created.body.id);
    assert.equal(done.headers.get('cache-control'), 'no-store');
    assert.equal(done.body.status, 'verified');
    assert.deepEqual(done.body.result.checks.map((c: { id: string }) => c.id), CHECK_ORDER);
    assert.ok(done.body.result.checks.every((c: { ok: boolean; code: string | null }) => c.ok && c.code === null));
    assert.deepEqual(done.body.result.claims, { ho_ten: NAME, nganh: MAJOR });
    assert.deepEqual(done.body.result.issuer, { maToChuc: 'VATVN-0100000001', ten: tenOf('VATVN-0100000001') });
    assert.equal(done.body.verifier.name, tenOf('VATVN-0100000005'));
    verifiedSessionId = created.body.id;

    for (const [status, expected] of [['suspended', 'SUSPENDED'], ['valid', null], ['revoked', 'REVOKED']] as const) {
      const changed = await call('POST', `/v1/issuers/truong-mau/credentials/${serverCredentialId}/status`, { token: registrar, body: { status } });
      assert.equal(changed.status, 200);

      // No waiting: the next verification reads the status list in-process.
      const next = await present(holder.wallet, credentialId);

      if (expected === null) {
        assert.equal(next.status, 'verified', status);
      } else {
        assert.equal(next.status, 'failed', status);
        assert.equal(codeAt(next.result.checks, 'status'), expected);
        assert.deepEqual(['claims' in next.result, 'issuer' in next.result], [false, false]);
      }
    }
  });
});

describe('negative paths over real HTTP', () => {
  let fresh: ReturnType<typeof newWallet>;
  let freshCredential = '';

  before(async () => {
    fresh = newWallet();
    freshCredential = await issueDiplomaTo(fresh.wallet, 'sv002');
  });

  it('a second response to the same session is refused; the result stays', async () => {
    const created = await createSession();
    const resolved = await fresh.wallet.presentations.resolve(created.body.qr);
    assert.ok(resolved.ok);
    if (!resolved.ok) return;

    assert.deepEqual(await fresh.wallet.presentations.submit(resolved.request, { credentialId: freshCredential, claimSetIndex: 1 }), { ok: true });
    const again = await fresh.wallet.presentations.submit(resolved.request, { credentialId: freshCredential, claimSetIndex: 0 });
    assert.equal(again.ok, false);
    assert.equal((await session(created.body.id)).body.status, 'verified');
    assert.deepEqual(Object.keys((await session(created.body.id)).body.result.claims), ['ho_ten', 'nganh']);
  });

  it('a session older than 5 minutes is expired: no request object, no response accepted', async (t) => {
    t.after(() => verifierClock.reset());
    const created = await createSession();
    const requestId = requestIdOf(created.body.qr);

    verifierClock.advance(301);
    assert.equal((await session(created.body.id)).body.status, 'expired');
    assert.equal((await fetch(`${LOCAL}/oid4vp/request/${requestId}`)).status, 404);
    const resolved = await fresh.wallet.presentations.resolve(created.body.qr);
    assert.equal(resolved.ok, false);
    const post = await fetch(`${LOCAL}/oid4vp/response/${requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'response=a.b.c.d.e'
    });
    assert.deepEqual([post.status, (await post.json()).error], [400, 'invalid_request']);
  });

  /** The request a photographed QR reveals, and a way to post forms to its response URI. */
  async function attacker(qr: string) {
    const requestId = requestIdOf(qr);
    const jwt = await (await fetch(`${LOCAL}/oid4vp/request/${requestId}`)).text();
    const payload = JSON.parse(utf8Decode(base64UrlDecode(jwt.split('.')[1]!)));
    const { kty, crv, x, y, kid } = payload.client_metadata.jwks.keys[0];
    const post = (form: string) =>
      fetch(`${LOCAL}/oid4vp/response/${requestId}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    const badJwe = () =>
      encryptJwe({
        recipientPublicJwk: { kty, crv, x, y },
        enc: 'A256GCM',
        plaintext: utf8Encode(JSON.stringify({ vp_token: { credential: ['not-a-presentation'] }, state: payload.state })),
        random: webCryptoRandom,
        header: { kid }
      });

    return { post, badJwe, state: payload.state as string };
  }

  it('a photographed QR: garbage and a well-formed JWE with a bad vp_token are refused, the session stays open', async () => {
    const created = await createSession();
    // The legitimate wallet has read the request; the attacker reads it too.
    const resolved = await fresh.wallet.presentations.resolve(created.body.qr);
    assert.ok(resolved.ok);
    if (!resolved.ok) return;
    const evil = await attacker(created.body.qr);

    for (const form of ['response=garbage', 'vp_token=x&state=y', `response=a.b.c.d.e&state=${evil.state}`, `response=${evil.badJwe()}`]) {
      const res = await evil.post(form);

      assert.deepEqual([res.status, (await res.json()).error], [400, 'invalid_request'], form.slice(0, 20));
    }
    assert.equal((await session(created.body.id)).body.status, 'request_retrieved', 'refused responses finalise nothing');

    // The legitimate wallet still completes the session.
    assert.deepEqual(await fresh.wallet.presentations.submit(resolved.request, { credentialId: freshCredential, claimSetIndex: 1 }), { ok: true });
    assert.equal((await session(created.body.id)).body.status, 'verified');
    assert.ok(logs.some((line) => line === `Presentation ${created.body.id.slice(0, 8)}: refused (MALFORMED)`));
  });

  it('ten refused responses finalise the session as failed (TOO_MANY_ATTEMPTS)', async () => {
    const created = await createSession();
    const evil = await attacker(created.body.qr);

    for (let i = 0; i < 10; i += 1) assert.equal((await evil.post(`response=${evil.badJwe()}`)).status, 400);

    const done = (await session(created.body.id)).body;
    assert.equal(done.status, 'failed');
    assert.equal(codeAt(done.result.checks, 'holder_binding'), 'TOO_MANY_ATTEMPTS');
    // Final: the request object is gone and further responses are refused.
    assert.equal((await fetch(`${LOCAL}/oid4vp/request/${requestIdOf(created.body.qr)}`)).status, 404);
    assert.equal((await evil.post(`response=${evil.badJwe()}`)).status, 400);
  });

  it('unknown sessions are 404, unknown verifier/scenario 404, extra fields 400', async () => {
    assert.deepEqual([(await session('A'.repeat(22))).status, (await session('A'.repeat(22))).body.code], [404, 'NOT_FOUND']);
    for (const body of [{ verifier: 'khong-co', scenario: 'ung-tuyen' }, { verifier: 'nha-tuyen-dung-mau', scenario: 'khong-co' }]) {
      const res = await call('POST', '/v1/verification/sessions', { body });
      assert.deepEqual([res.status, res.body.code], [404, 'NOT_FOUND']);
    }
    const extra = await call('POST', '/v1/verification/sessions', { body: { verifier: 'nha-tuyen-dung-mau', scenario: 'ung-tuyen', requestId: 'x' } });
    assert.deepEqual([extra.status, extra.body.code], [400, 'VALIDATION_FAILED']);
  });

  it('limits session creation to 30 per minute per IP (429 RATE_LIMITED with Retry-After)', async () => {
    for (let i = 0; i < 30; i += 1) assert.equal((await createSession('203.0.113.160')).status, 201);

    const limited = await createSession('203.0.113.160');
    assert.deepEqual([limited.status, limited.body.code], [429, 'RATE_LIMITED']);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });

  it('a wallet pinning another root refuses the verifier before showing anything', async () => {
    const created = await createSession();
    const other = newWallet(join(demoPkiDir(), 'ca', 'issuing', 'ca.cert.pem'));
    const resolved = await other.wallet.presentations.resolve(created.body.qr);

    assert.equal(resolved.ok, false);
    assert.match(!resolved.ok ? resolved.code : '', /^CERT_/);
    assert.equal((await session(created.body.id)).body.status, 'request_retrieved');
  });
});

describe('no personal data at rest after a verified session', () => {
  it('Postgres has none, Redis only under the result key (TTL ≤ 1800 s), then nothing', async () => {
    const prisma = app.get(PrismaService);
    const redis = app.get(RedisService).getClient();
    const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'json', 'jsonb', 'USER-DEFINED')`;
    const pgHits = new Set<string>();

    for (const { table_name: table, column_name: column } of columns) {
      for (const needle of [NAME, DIPLOMA_NUMBER, MAJOR]) {
        const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM "${table}" WHERE position($1 in "${column}"::text) > 0`,
          needle
        );

        if (n > 0n) pgHits.add(`${table}.${column}`);
      }
    }

    assert.deepEqual([...pgHits], ['DemoPortalAccount.profile']);

    const holding = async () => {
      const found: Array<{ key: string; ttl: number }> = [];

      for (const key of await redis.keys('*')) {
        const value = (await redis.type(key)) === 'string' ? ((await redis.get(key)) ?? '') : '';

        if (value.includes(DIPLOMA_NUMBER)) throw new Error(`the undisclosed diploma number is in ${key}`);
        if (value.includes(NAME)) found.push({ key, ttl: await redis.ttl(key) });
      }

      return found;
    };
    const found = await holding();

    assert.ok(found.length > 0);
    assert.ok(found.every(({ key, ttl }) => /^state:vp:vp:x509_hash:[A-Za-z0-9_-]{43}:result:[A-Za-z0-9_-]{22}$/.test(key) && ttl > 0 && ttl <= 1800), JSON.stringify(found));
    assert.ok(found.some(({ key }) => key.endsWith(`:result:${verifiedSessionId}`)));

    // Past its TTL the result is gone, and so is the session.
    for (const { key } of found) await redis.pexpire(key, 1);
    for (const key of await redis.keys(`state:vp:*:session:${verifiedSessionId}`)) await redis.pexpire(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await holding(), []);
    assert.equal((await session(verifiedSessionId)).status, 404);

    // The log lines name the session by an 8-character prefix and carry no claim value.
    assert.ok(logs.some((line) => new RegExp(`^Presentation ${verifiedSessionId.slice(0, 8)}: verified$`).test(line)));
    assert.ok(logs.some((line) => /^Presentation [A-Za-z0-9_-]{8}: failed \(REVOKED\)$/.test(line)));
    assert.ok(logs.every((line) => !line.includes(NAME) && !line.includes(MAJOR) && !line.includes(verifiedSessionId)));
    console.log(
      `no-PII-at-rest (verification): ${columns.length} text/json columns, hits only in DemoPortalAccount.profile; ` +
        `${found.length} Redis result keys held the name (TTL ≤ 1800 s), 0 after expiry; ${logs.length} log lines, 0 with claims`
    );
  });
});
