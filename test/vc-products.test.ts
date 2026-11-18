// Product lifecycle (docs/vc-api.md §7, ADR-0012) over real HTTP: the consumer is the SDK's own
// product page verifier (@identra/sdk-client/product), pinning the demo root, reaching the
// canonical origin through its fetch mapping.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CONG_DOAN, formatProductCode, issueProductEvent, type CongDoan } from '@identra/sdk-core';
import { appendProductEvent, type StatusListService } from '@identra/sdk-server';
import { createProductVerifier } from '@identra/sdk-client/product';
import { NestExpressApplication } from '@nestjs/platform-express';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { ProductEventsService } from '../src/vc/products';
import { PKI, Pki, STATUS_LIST_SERVICE } from '../src/vc/vc.providers';
import { derOf, keysDir, LOCAL, PORT } from './e2e-world';
import { createTestApp } from './helpers';

const GTIN = '09520123456788';
const ORGS: Record<CongDoan, string> = { san_xuat: 'nha-san-xuat', kiem_dinh: 'kiem-dinh', phan_phoi: 'phan-phoi' };
const KEYS = Object.fromEntries(['nha-san-xuat', 'kiem-dinh', 'phan-phoi', 'truong-mau'].map((org) => [org, randomBytes(32).toString('base64url')]));
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const trustSource = JSON.parse(readFileSync(join(keysDir, 'trust-list.source.json'), 'utf8')) as { issuers: Array<{ ma_to_chuc: string; ten: string }> };
const tenOf = (maToChuc: string) => trustSource.issuers.find((e) => e.ma_to_chuc === maToChuc)!.ten;

let app: NestExpressApplication;
let products: ProductEventsService;
let statusLists: StatusListService;
let pki: Pki;

before(async () => {
  app = await createTestApp({
    IDENTRA_KEYS_DIR: keysDir,
    IDENTRA_ORG_API_KEY_HASHES: Object.entries(KEYS).map(([org, key]) => `${org}:${sha256(key)}`).join(',')
  });
  await app.listen(PORT, '127.0.0.1');
  products = app.get(ProductEventsService);
  statusLists = app.get(STATUS_LIST_SERVICE);
  pki = app.get(PKI);

  // The real provisioning command, twice for the full chain (idempotent) and once with two stages.
  const provision = (env: Record<string, string>) =>
    execFileSync(process.execPath, [join(__dirname, '../src/scripts/demo-provision-product.js')], {
      env: { ...process.env, IDENTRA_KEYS_DIR: keysDir, ...env },
      stdio: 'pipe'
    }).toString();
  provision({ DEMO_PRODUCT_PROVISION: 'yes' });
  assert.match(provision({ DEMO_PRODUCT_PROVISION: 'yes' }), /phan_phoi already stored/);
  provision({ DEMO_PRODUCT_PROVISION: 'yes', DEMO_PRODUCT_SERIAL: 'SN-2026-000002', DEMO_PRODUCT_STAGES: '2' });
});

after(async () => {
  await app?.close();
});

/** A fresh page verifier per load: its caches never hide a change made by the test. */
const load = (serial: string) =>
  createProductVerifier({ apiBaseUrl: LOCAL, rootCertificates: [derOf(join(keysDir, 'root.cert.pem'))] }).load(GTIN, serial);
const eventsUrl = (serial: string, gtin = GTIN) => `${LOCAL}/v1/products/${gtin}/${encodeURIComponent(serial)}/events`;
const post = (serial: string, credential: string, org?: string, ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`) =>
  fetch(eventsUrl(serial), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(org ? { authorization: `Bearer ${KEYS[org]}` } : {}) },
    body: JSON.stringify({ credential })
  });
const codeAt = (checks: Array<{ id: string; code: string | null }>, id: string) => checks.find((c) => c.id === id)?.code;

/** The next event of `serial`, signed in-process by the stage's organisation (or `override`). */
async function nextEvent(serial: string, existing: string[], o: { now?: Date; product?: string } = {}) {
  const congDoan = CONG_DOAN[existing.length]!;
  const org = ORGS[congDoan];
  const status = await statusLists.allocate(org);
  const clock = o.now ? { now: () => o.now! } : pki.clock;

  return appendProductEvent({
    gtin: GTIN,
    serial: o.product ?? serial,
    existing,
    iss: pki.issuerUri(org),
    status: { uri: status.uri, idx: status.idx },
    claims: { congDoan, thoiDiem: clock.now().toISOString().replace(/\.\d{3}Z$/, 'Z'), diaDiem: 'Kho thử nghiệm (DEMO)', moTa: 'Sự kiện thử nghiệm (DEMO).' },
    verify: products.verifyOptions(),
    signer: await pki.keyStore.signer(org, 'vc'),
    hasher: pki.hasher,
    random: pki.random,
    clock
  });
}

/** A product with all three stages stored through the service. */
async function fullProduct(): Promise<string> {
  const serial = `SN-T-${randomBytes(4).toString('hex')}`;

  for (let i = 0; i < 3; i += 1) {
    const compact = await nextEvent(serial, await products.events(GTIN, serial));
    await products.store({ gtin: GTIN, serial, compact, actingOrg: ORGS[CONG_DOAN[i]!] });
  }

  return serial;
}

describe('provisioned products, verified by the product page SDK', () => {
  it('the sample chain loads and verifies with three events and trust-list issuer names', async () => {
    const view = await load('SN-2026-000001');

    assert.equal(view.state, 'ok');
    assert.equal(view.result?.state, 'verified');
    assert.equal(view.result?.events.length, 3);
    assert.deepEqual(view.result?.events.map((e) => e.event?.congDoan), [...CONG_DOAN]);
    assert.deepEqual(
      view.result?.events.map((e) => e.event?.issuer.ten),
      ['VATVN-0100000002', 'VATVN-0100000003', 'VATVN-0100000004'].map(tenOf)
    );
    assert.ok(view.serverTime && Math.abs(view.clockSkewSeconds ?? 99) < 5);
  });

  it('the two-stage product is in progress', async () => {
    const view = await load('SN-2026-000002');

    assert.equal(view.result?.state, 'in_progress');
    assert.deepEqual(view.result?.missingStages, ['phan_phoi']);
  });

  it('GET is public, never cached, carries serverTime, 1200/min; unknown 404; malformed 400', async () => {
    const res = await fetch(eventsUrl('SN-2026-000001'), { headers: { origin: 'https://evil.example' } });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['events', 'gtin', 'serial', 'serverTime']);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-ratelimit-limit'), '1200');

    // Product issuers have their status lists but no OpenID4VCI endpoints.
    assert.equal((await fetch(`${LOCAL}/issuers/nha-san-xuat/status/1`)).status, 200);
    for (const [method, path] of [
      ['GET', '/.well-known/openid-credential-issuer/issuers/nha-san-xuat'],
      ['GET', '/issuers/kiem-dinh/jwks'],
      ['POST', '/issuers/phan-phoi/nonce']
    ] as const) {
      const r = await fetch(`${LOCAL}${path}`, { method });
      assert.deepEqual([r.status, (await r.json()).error], [404, 'not_found'], path);
    }

    const unknown = await fetch(eventsUrl('SN-KHONG-CO'));
    assert.deepEqual([unknown.status, (await unknown.json()).code], [404, 'NOT_FOUND']);

    for (const path of [
      `/v1/products/09520123456789/SN-1/events`, // check digit
      `/v1/products/9520123456788/SN-1/events`, // 13 digits
      `/v1/products/${GTIN}/SN%2f1/events`, // lower-case escape
      `/v1/products/${GTIN}/SN%2541/events`, // double encoded
      `/v1/products/${GTIN}/${'S'.repeat(21)}/events` // 21 characters
    ]) {
      const r = await fetch(`${LOCAL}${path}`);
      assert.deepEqual([r.status, (await r.json()).code], [400, 'VALIDATION_FAILED'], path);
    }

    // The one accepted path form of a serial with a set-82 character outside A-Z a-z 0-9 - . _
    const odd = 'SN/2026+1';
    const stored = await nextEvent(odd, []);
    await products.store({ gtin: GTIN, serial: odd, compact: stored, actingOrg: 'nha-san-xuat' });
    const oddRes = await fetch(`${LOCAL}/v1/products/${GTIN}/SN%2F2026%2B1/events`);
    assert.deepEqual([oddRes.status, (await oddRes.json()).serial], [200, odd]);
  });
});

describe('POST /v1/products/:gtin/:serial/events', () => {
  it('authorisation and chain rules', async () => {
    const serial = `SN-P-${randomBytes(4).toString('hex')}`;
    const first = await nextEvent(serial, []);
    const status = async (r: Response) => [r.status, ((await r.json()) as { code?: string; reason?: string })] as const;

    let [code, body] = await status(await post(serial, first));
    assert.deepEqual([code, body.code], [401, 'SESSION_EXPIRED'], 'no key');
    [code, body] = await status(await post(serial, first, 'kiem-dinh'));
    assert.deepEqual([code, body.code], [403, 'FORBIDDEN'], 'another organisation');
    [code, body] = await status(await post(serial, first, 'truong-mau'));
    assert.deepEqual([code, body.code], [403, 'FORBIDDEN'], 'not a product issuer');

    // Right key, wrong stage: kiem_dinh as the first event.
    const kdStatus = await statusLists.allocate('kiem-dinh');
    const wrongStage = await issueProductEvent({
      signer: await pki.keyStore.signer('kiem-dinh', 'vc'),
      hasher: pki.hasher,
      random: pki.random,
      clock: pki.clock,
      iss: pki.issuerUri('kiem-dinh'),
      status: { uri: kdStatus.uri, idx: kdStatus.idx },
      claims: {
        ma_san_pham: formatProductCode(GTIN, serial),
        cong_doan: 'kiem_dinh',
        thoi_diem: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        dia_diem: 'x',
        mo_ta: 'x'
      }
    });
    [code, body] = await status(await post(serial, wrongStage, 'kiem-dinh'));
    assert.deepEqual([code, body.code, body.reason], [409, 'CONFLICT', 'CHAIN_BROKEN'], 'wrong stage');

    // Right key, right stage.
    const ok = await post(serial, first, 'nha-san-xuat');
    assert.deepEqual([ok.status, await ok.json()], [201, { seq: 0 }]);

    // The same stage again (a second san_xuat event).
    [code, body] = await status(await post(serial, await nextEvent(serial, []), 'nha-san-xuat'));
    assert.deepEqual([code, body.code, body.reason], [409, 'CONFLICT', 'CHAIN_BROKEN'], 'duplicate stage');

    // Two different kiem_dinh events at once: exactly one is stored.
    const [a, b] = [await nextEvent(serial, [first]), await nextEvent(serial, [first])];
    const both = await Promise.all([post(serial, a, 'kiem-dinh'), post(serial, b, 'kiem-dinh')]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await products.events(GTIN, serial)).length, 2);

    // An event of another product.
    const other = `SN-O-${randomBytes(4).toString('hex')}`;
    [code, body] = await status(await post(other, await nextEvent(serial, [], { product: `SN-X-${randomBytes(4).toString('hex')}` }), 'nha-san-xuat'));
    assert.deepEqual([code, body.code, body.reason], [409, 'CONFLICT', 'CHAIN_BROKEN'], 'another product');

    // A tampered event (one character of the payload flipped).
    const stored = await products.events(GTIN, serial);
    const genuine = await nextEvent(serial, stored);
    const [h, p, sig] = genuine.split('~')[0]!.split('.');
    const flipped = `${h}.${p!.slice(0, 10)}${p![10] === 'A' ? 'B' : 'A'}${p!.slice(11)}.${sig}~`;
    [code, body] = await status(await post(serial, flipped, 'phan-phoi'));
    assert.deepEqual([code, body.code], [400, 'VALIDATION_FAILED'], 'tampered');
    assert.ok(['SIGNATURE_INVALID', 'MALFORMED'].includes(body.reason!), body.reason);

    // An event dated in the future (signed by a clock a day ahead).
    const future = await nextEvent(serial, stored, { now: new Date(Date.now() + 86_400_000) });
    [code, body] = await status(await post(serial, future, 'phan-phoi'));
    assert.deepEqual([code, body.code, body.reason], [400, 'VALIDATION_FAILED', 'NOT_YET_VALID'], 'future');

    const done = await post(serial, genuine, 'phan-phoi');
    assert.deepEqual([done.status, await done.json()], [201, { seq: 2 }]);
    assert.equal((await load(serial)).result?.state, 'verified');
  });

  it('is rate limited (write: 60 per minute per IP)', async () => {
    for (let i = 0; i < 60; i += 1) await post('SN-RL', 'x', undefined, '203.0.113.170');

    const limited = await post('SN-RL', 'x', undefined, '203.0.113.170');
    assert.deepEqual([limited.status, (await limited.json()).code], [429, 'RATE_LIMITED']);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

describe('revocation and tampering are visible on the very next load', () => {
  it('revoking event 2 shows red at exactly that step', async () => {
    const serial = await fullProduct();
    const row = await app.get(PrismaService).productEvent.findFirstOrThrow({ where: { gtin: GTIN, serial, seq: 1 } });
    const res = await fetch(`${LOCAL}/v1/issuers/kiem-dinh/credentials/${row.id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS['kiem-dinh']}` },
      body: JSON.stringify({ status: 'revoked' })
    });
    assert.deepEqual([res.status, (await res.json()).status], [200, 'revoked']);

    const view = await load(serial);
    const events = view.result!.events;

    assert.equal(view.result?.state, 'failed');
    assert.deepEqual(events.map((e) => e.ok), [true, false, true]);
    assert.equal(codeAt(events[1]!.checks, 'status'), 'REVOKED');
    assert.ok(events[1]!.event, 'a revoked step is still shown, in red');

    // Revocation is final; another organisation cannot touch it.
    const again = await fetch(`${LOCAL}/v1/issuers/kiem-dinh/credentials/${row.id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS['kiem-dinh']}` },
      body: JSON.stringify({ status: 'valid' })
    });
    assert.equal(again.status, 409);
    const foreign = await fetch(`${LOCAL}/v1/issuers/kiem-dinh/credentials/${row.id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS['phan-phoi']}` },
      body: JSON.stringify({ status: 'suspended' })
    });
    assert.equal(foreign.status, 403);
  });

  it('a compact tampered with in the database is served as stored and fails on the page', async () => {
    const serial = await fullProduct();
    const prisma = app.get(PrismaService);
    const row = await prisma.productEvent.findFirstOrThrow({ where: { gtin: GTIN, serial, seq: 1 } });
    const [h, p, rest] = [row.compact.split('.')[0], row.compact.split('.')[1]!, row.compact.split('.').slice(2).join('.')];
    const tampered = `${h}.${p.slice(0, 20)}${p[20] === 'A' ? 'B' : 'A'}${p.slice(21)}.${rest}`;

    await prisma.productEvent.update({ where: { id: row.id }, data: { compact: tampered } });

    const served = await (await fetch(eventsUrl(serial))).json();
    assert.equal(served.events[1], tampered, 'not an authority: the store serves what it holds');

    const events = (await load(serial)).result!.events;
    assert.equal(events[0]!.ok, true);
    assert.equal(events[1]!.ok, false);
    assert.ok(['SIGNATURE_INVALID', 'MALFORMED'].includes(events[1]!.checks.find((c) => !c.ok)!.code!));
    assert.equal(codeAt(events[2]!.checks, 'product_chain'), 'CHAIN_BROKEN');
  });
});
