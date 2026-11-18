// Regression tests for the independent review of the status-change and trust-list code.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTrustListToken, statusListEntry, STATUS_LIST_BYTES } from '@identra/sdk-core';
import type { StatusListService } from '@identra/sdk-server';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { createPrismaStatusListStorage } from '../src/vc/status-storage';
import { verifiedLastToken } from '../src/vc/trust-list';
import { STATUS_CHANGE_HOOKS, VcCredentialsService } from '../src/vc/vc-credentials.service';
import { PKI, Pki, refuseCaKeys, STATUS_LIST_SERVICE } from '../src/vc/vc.providers';
import { createTestApp, demoPkiDir, randomIp, testKeysDir } from './helpers';

const ISSUER = 'truong-mau';
const VCT = 'https://identra.awncorp.vn/vct/bang-tot-nghiep/v1';
const VALUE = { valid: 0, revoked: 1, suspended: 2 } as const;
const issuerKey = randomBytes(32).toString('base64url');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam of VcCredentialsService: delays queued here run inside a status change, after the locks. */
const hooks = {
  delays: [] as number[],
  entered: () => undefined as void,
  async insideStatusChange() {
    const delay = hooks.delays.shift();

    if (delay) {
      hooks.entered();
      await sleep(delay);
    }
  }
};
/** Resolves once a delayed change is inside its transaction, i.e. holds its locks. */
const nextDelayedChangeHoldsLocks = () => new Promise<void>((resolve) => (hooks.entered = resolve));

let app: NestExpressApplication;
let prisma: PrismaService;
let credentials: VcCredentialsService;
let statusLists: StatusListService;
let pki: Pki;

before(async () => {
  app = await createTestApp(
    {
      IDENTRA_KEYS_DIR: testKeysDir(),
      IDENTRA_ORG_API_KEY_HASHES: `${ISSUER}:${createHash('sha256').update(issuerKey).digest('hex')}`
    },
    { override: (builder) => builder.overrideProvider(STATUS_CHANGE_HOOKS).useValue(hooks) }
  );
  prisma = app.get(PrismaService);
  credentials = app.get(VcCredentialsService);
  statusLists = app.get(STATUS_LIST_SERVICE);
  pki = app.get(PKI);
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());
const issue = () =>
  credentials.register({ issuerName: ISSUER, vct: VCT, subjectRef: 'sv001', cnfThumbprint: randomBytes(32).toString('base64url') });
const change = (id: string, status: string) =>
  http()
    .post(`/v1/issuers/${ISSUER}/credentials/${id}/status`)
    .set('X-Forwarded-For', randomIp())
    .auth(issuerKey, { type: 'bearer' })
    .send({ status });
async function rowAndList(id: string) {
  const row = await prisma.vcIssuedCredential.findUniqueOrThrow({ where: { id } });
  const list = await prisma.vcStatusList.findUniqueOrThrow({
    where: { issuerName_listNumber: { issuerName: ISSUER, listNumber: row.statusListNumber } }
  });

  return { row: VALUE[row.status], list: statusListEntry(new Uint8Array(list.bytes), row.statusIndex) };
}

describe('status changes: row and list never disagree (F2)', () => {
  for (const [first, third] of [['suspended', 'valid'], ['suspended', 'revoked']] as const) {
    it(`overlapping ${first} / ${first} / ${third} end with row = list = ${third}`, async () => {
      const { id } = await issue();

      // The reviewer's staleRowRace: T2 is slow inside its change, T1 and T3 come while it runs.
      hooks.delays.push(600);
      const t2 = change(id, first).then((r) => r.status);
      await sleep(50);
      const t1 = change(id, first).then((r) => r.status);
      await sleep(400);
      const t3 = change(id, third).then((r) => r.status);

      assert.deepEqual(await Promise.all([t2, t1, t3]), [200, 200, 200]);
      assert.deepEqual(await rowAndList(id), { row: VALUE[third], list: VALUE[third] });
    });
  }

  it('a request for the status the row already has repairs a list that disagrees', async () => {
    const { id, status } = await issue();
    const n = Number(status.uri.split('/').pop());

    // A list changed behind the row's back (e.g. by an earlier partial failure).
    await statusLists.setStatus(ISSUER, n, status.idx, 'suspended');
    assert.deepEqual(await rowAndList(id), { row: VALUE.valid, list: VALUE.suspended });

    await change(id, 'valid').expect(200);
    assert.deepEqual(await rowAndList(id), { row: VALUE.valid, list: VALUE.valid });
  });

  it('a list already revoked makes the row follow and the request answer 409', async () => {
    const { id, status } = await issue();

    await statusLists.setStatus(ISSUER, Number(status.uri.split('/').pop()), status.idx, 'revoked');
    const res = await change(id, 'suspended').expect(409);

    assert.equal(res.body.code, 'CONFLICT');
    assert.deepEqual(await rowAndList(id), { row: VALUE.revoked, list: VALUE.revoked });
  });
});

describe('status changes under load (F6)', () => {
  it('60 concurrent changes on one list: only 200 or 503 with Retry-After, never 500', async () => {
    const ids = await Promise.all(Array.from({ length: 60 }, async () => (await issue()).id));
    const responses = await Promise.all(ids.map((id) => change(id, 'suspended')));
    const statuses = responses.map((r) => r.status);

    assert.ok(statuses.every((s) => s === 200 || s === 503), JSON.stringify(statuses));
    for (const r of responses.filter((x) => x.status === 503)) {
      assert.equal(r.body.code, 'UNAVAILABLE');
      assert.equal(r.headers['retry-after'], '1');
    }
    for (const id of ids) {
      const state = await rowAndList(id);

      assert.equal(state.row, state.list, id);
    }
  });

  it('the public status list GET does not wait for a writer holding the list lock', async () => {
    const a = await issue();
    const b = await issue();
    const n = a.status.uri.split('/').pop();
    const held = (await http().get(`/issuers/${ISSUER}/status/${n}`).expect(200)).text;

    await change(a.id, 'suspended').expect(200); // the list changed: the next GET must re-sign
    hooks.delays.push(3000);
    const locked = nextDelayedChangeHoldsLocks();
    // .then() sends the request now (a supertest request is lazy).
    const slow = change(b.id, 'suspended').then((r) => r);

    await locked;
    const started = Date.now();
    const res = await http().get(`/issuers/${ISSUER}/status/${n}`).expect(200);
    const waited = Date.now() - started;

    assert.ok(waited < 2000, `waited ${waited} ms`);
    assert.equal(res.text, held, 'the last token served is served again');
    assert.equal((await slow).status, 200);
    assert.notEqual((await http().get(`/issuers/${ISSUER}/status/${n}`).expect(200)).text, held);
  });
});

describe('status-list storage keeps its optimistic version (mutation survivor)', () => {
  it('two writers with the same expected version: exactly one wins; a stale version loses', async () => {
    const storage = createPrismaStatusListStorage(prisma);
    const issuer = `version-test-${randomBytes(3).toString('hex')}`;

    assert.equal(await storage.save(issuer, 1, new Uint8Array(STATUS_LIST_BYTES), null), true);
    const { version } = (await storage.load(issuer, 1))!;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => storage.save(issuer, 1, new Uint8Array(STATUS_LIST_BYTES).fill(i + 1), version))
    );

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await storage.save(issuer, 1, new Uint8Array(STATUS_LIST_BYTES), version), false);
    assert.equal((await storage.load(issuer, 1))!.version, version + 1);
  });
});

describe('the stored last trust-list token is verified before use (F7)', () => {
  const content = () => JSON.parse(readFileSync(join(testKeysDir(), 'trust-list.source.json'), 'utf8'));

  it('accepts a token of the current signer and refuses garbage, a future iat and another signer', async () => {
    const signer = await pki.keyStore.trustListSigner();
    const now = new Date();
    const good = await createTrustListToken({ ...content(), signer, now });
    const future = await createTrustListToken({ ...content(), signer, now: new Date(now.getTime() + 120_000) });
    const statusSigner = await pki.keyStore.signer(ISSUER, 'status');
    const leafOnly = { ...statusSigner, x5c: [statusSigner.x5c![0]!] };
    const other = await createTrustListToken({ ...content(), signer: leafOnly, now }).catch(() => 'not-a-token');

    assert.equal(await verifiedLastToken(good, pki), good);
    assert.equal(await verifiedLastToken(null, pki), undefined);
    assert.equal(await verifiedLastToken('garbage', pki), undefined);
    assert.equal(await verifiedLastToken(future, pki), undefined);
    assert.equal(await verifiedLastToken(other, pki), undefined);
  });

  it('keeps the served token in Redis (mutation survivor: persistence)', async () => {
    const served = (await http().get('/trust-list').expect(200)).text;

    assert.equal(await app.get(RedisService).getClient().get('state:trust-list:last-token'), served);
  });
});

describe('CA keys never on the server (F9)', () => {
  it('refuses a key directory with a ca/ directory or a ca.key.pem, naming the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'identra-ca-test-'));

    try {
      symlinkSync(join(demoPkiDir(), 'orgs'), join(dir, 'orgs'));
      refuseCaKeys(dir);

      mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true });
      symlinkSync(join(demoPkiDir(), 'root.cert.pem'), join(dir, 'nested', 'deeper', 'ca.key.pem'));
      assert.throws(() => refuseCaKeys(dir), (e: Error) => e.message.includes(join(dir, 'nested', 'deeper', 'ca.key.pem')) && !e.message.includes('BEGIN'));

      rmSync(join(dir, 'nested'), { recursive: true });
      mkdirSync(join(dir, 'ca'));
      assert.throws(() => refuseCaKeys(dir), new RegExp(`${join(dir, 'ca')} looks like CA key material`));
      // The real demo PKI keeps its CA keys in ca/: it must be refused as a key directory.
      assert.throws(() => refuseCaKeys(demoPkiDir()), /looks like CA key material/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
