import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { NETWORK_SHARES } from '../src/common/live-cap';
import {
  MAX_CONCURRENT_HASHES,
  REGISTRAR_ACCOUNT_FAILURES,
  REGISTRAR_FAILURES,
  REGISTRAR_WINDOW_SECONDS,
  sessionHashOf
} from '../src/demo-portal/portal-sessions';
import { DEMO_ACCOUNTS, DEMO_DID_ACCOUNTS, DEMO_DID_ISSUER, DID_ACCOUNT_PREFIX } from '../src/demo-portal/demo-accounts';
import { createTestApp, portalLogin, PROVISION_ENV, randomIp, seedPortalAccounts, TEST_PORTAL_PASSWORD, TEST_REGISTRAR_PASSWORD } from './helpers';

// Runs without keys: the portal itself needs none. Credential rows are inserted directly.
let app: NestExpressApplication;
let prisma: PrismaService;

before(async () => {
  app = await createTestApp();
  prisma = app.get(PrismaService);
  await seedPortalAccounts(prisma);
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());
const login = (username: string, password: string, ip = randomIp()) =>
  http().post('/v1/demo/school/login').set('X-Forwarded-For', ip).send({ username, password });

describe('npm run demo:provision', () => {
  const script = join(__dirname, '../src/scripts/demo-provision.js');

  it('refuses to run without both passwords, or with the registrar sharing the public one', () => {
    const { DEMO_PORTAL_PASSWORD: _a, DEMO_PORTAL_REGISTRAR_PASSWORD: _b, ...base } = process.env;
    const refused: Array<[Record<string, string>, RegExp]> = [
      [{}, /DEMO_PORTAL_PASSWORD/],
      [{ DEMO_PORTAL_PASSWORD: TEST_PORTAL_PASSWORD }, /DEMO_PORTAL_REGISTRAR_PASSWORD/],
      [{ DEMO_PORTAL_REGISTRAR_PASSWORD: TEST_REGISTRAR_PASSWORD }, /DEMO_PORTAL_PASSWORD/],
      [{ DEMO_PORTAL_PASSWORD: 'Same-Pass-2026-Same-1', DEMO_PORTAL_REGISTRAR_PASSWORD: 'Same-Pass-2026-Same-1' }, /must differ/],
      [{ DEMO_PORTAL_PASSWORD: TEST_PORTAL_PASSWORD, DEMO_PORTAL_REGISTRAR_PASSWORD: 'short' }, /at least 20/],
      // 19 characters: the registrar's name is public, so its password must resist guessing on its own.
      [{ DEMO_PORTAL_PASSWORD: TEST_PORTAL_PASSWORD, DEMO_PORTAL_REGISTRAR_PASSWORD: 'Registrar-Pass-2026' }, /at least 20/]
    ];

    for (const [extra, message] of refused) {
      assert.throws(
        () => execFileSync(process.execPath, [script], { env: { ...base, ...extra }, stdio: 'pipe' }),
        (error: { stderr: Buffer }) => /refuses to run/.test(String(error.stderr)) && message.test(String(error.stderr))
      );
    }
  });

  it('upserts the four sample accounts, idempotently, and nothing else; the registrar has its own password', async (t) => {
    t.after(() => seedPortalAccounts(prisma)); // back to the test passwords, even on failure
    const usersBefore = await prisma.user.count();
    const env = { ...process.env, DEMO_PORTAL_PASSWORD: 'Another-Pass-2026', DEMO_PORTAL_REGISTRAR_PASSWORD: 'Registrar-Pass-2026-Other' };

    execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
    const output = execFileSync(process.execPath, [script], { env, stdio: 'pipe' }).toString();

    assert.match(output, /sv001 \(student\)[\s\S]*phongdaotao \(registrar\)/);
    assert.ok(!output.includes('Another-Pass-2026') && !output.includes('Registrar-Pass-2026-Other'));
    assert.equal(await prisma.demoPortalAccount.count({ where: { username: { in: ['sv001', 'sv002', 'sv003', 'phongdaotao'] } } }), 4);
    assert.equal(await prisma.user.count(), usersBefore);

    const sv003 = await prisma.demoPortalAccount.findUniqueOrThrow({ where: { username: 'sv003' } });
    const profile = sv003.profile as Record<string, string>;

    assert.equal(sv003.role, 'student');
    assert.equal(sv003.issuerName, 'truong-mau');
    assert.deepEqual(Object.keys(profile).sort(), ['hangTotNghiep', 'hoTen', 'maSinhVien', 'namTotNghiep', 'nganh', 'ngaySinh', 'soHieuBang']);
    assert.match(profile.ngaySinh!, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof profile.namTotNghiep, 'string');

    await login('sv003', 'Another-Pass-2026').expect(201);
    // The public student password does not open the registrar account; its own does.
    const refused = await login('phongdaotao', 'Another-Pass-2026').expect(401);
    assert.equal(refused.body.code, 'INVALID_CREDENTIALS');
    assert.equal((await login('phongdaotao', 'Registrar-Pass-2026-Other').expect(201)).body.role, 'registrar');
  });

  it('with DPKI configured the second school\'s registrar needs its own password: 20+ characters, neither the public one nor the first registrar\'s', () => {
    const dpki = { CERTNET_GATEWAY_URL: 'https://gateway.certnet.example', CERTNET_NETWORK: 'local' };
    const refused: Array<[Record<string, string>, RegExp]> = [
      [{}, /set DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET/],
      [{ DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET: 'Registrar-Pass-2026' }, /DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET \(the private registrar password, at least 20/],
      [{ DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET: TEST_REGISTRAR_PASSWORD }, /DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET must differ from DEMO_PORTAL_REGISTRAR_PASSWORD/],
      [
        { DEMO_PORTAL_PASSWORD: 'Same-Pass-2026-Same-1', DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET: 'Same-Pass-2026-Same-1' },
        /DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET must differ from the public DEMO_PORTAL_PASSWORD/
      ]
    ];

    for (const [extra, message] of refused) {
      assert.throws(
        () => execFileSync(process.execPath, [script], { env: { ...process.env, ...PROVISION_ENV, ...dpki, DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET: '', ...extra }, stdio: 'pipe' }),
        (error: { stderr: Buffer }) => /refuses to run/.test(String(error.stderr)) && message.test(String(error.stderr)),
        JSON.stringify(extra)
      );
    }
  });

  it('with DPKI off it creates no account of the DID issuer, and needs no third password', async (t) => {
    t.after(() => seedPortalAccounts(prisma));
    await prisma.demoPortalAccount.deleteMany({ where: { username: { startsWith: DID_ACCOUNT_PREFIX } } });
    const { DEMO_PORTAL_REGISTRAR_PASSWORD_CERTNET: _c, ...env } = { ...process.env, ...PROVISION_ENV };
    const output = execFileSync(process.execPath, [script], { env, stdio: 'pipe' }).toString();

    assert.ok(!output.includes(DID_ACCOUNT_PREFIX), output);
    assert.equal(await prisma.demoPortalAccount.count({ where: { OR: [{ username: { startsWith: DID_ACCOUNT_PREFIX } }, { issuerName: DEMO_DID_ISSUER }] } }), 0);
  });
});

describe('the sample data of the two schools', () => {
  it('the CertNet school\'s students are other people: own names, birth dates, student codes (DEMO) and diploma numbers', () => {
    const students = (accounts: typeof DEMO_ACCOUNTS) => accounts.flatMap((a) => (a.role === 'student' ? [a.profile] : []));
    const [tm, cn] = [students(DEMO_ACCOUNTS), students(DEMO_DID_ACCOUNTS)];

    assert.deepEqual(DEMO_DID_ACCOUNTS.map((a) => [a.username, a.role]), DEMO_ACCOUNTS.map((a) => [a.username, a.role]));
    assert.equal(cn.length, 3);

    for (const field of ['hoTen', 'ngaySinh', 'maSinhVien', 'soHieuBang'] as const) {
      assert.deepEqual(cn.filter((p) => tm.some((q) => q[field] === p[field])), [], field);
    }

    assert.ok(cn.every((p) => /^DEMO\d{2}[A-Z]+\d{4}$/.test(p.maSinhVien) && /^CNDEMO-\d{4}-\d{6}$/.test(p.soHieuBang) && /^\d{4}-\d{2}-\d{2}$/.test(p.ngaySinh)));

    const registrar = (accounts: typeof DEMO_ACCOUNTS) => accounts.find((a) => a.role === 'registrar')!.profile.hoTen;

    assert.notEqual(registrar(DEMO_DID_ACCOUNTS), registrar(DEMO_ACCOUNTS));
  });
});

describe('POST /v1/demo/school/login', () => {
  it('signs in and stores only a hash of the token, for 30 minutes', async () => {
    const res = await login('sv001', TEST_PORTAL_PASSWORD).expect(201);
    const { token, expiresAt, serverTime, role, profile } = res.body;
    const redis = app.get(RedisService).getClient();
    const key = `state:portal-session:${createHash('sha256').update(token).digest('hex')}`;

    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(role, 'student');
    assert.equal(profile.hoTen, 'Nguyễn Thị Minh Anh');
    assert.equal(Date.parse(expiresAt) - Date.parse(serverTime), 30 * 60 * 1000);
    const ttl = await redis.ttl(key);

    assert.ok(ttl > 29 * 60 && ttl <= 30 * 60, `ttl ${ttl}`);
    assert.deepEqual(await redis.keys(`*${token}*`), []);
  });

  it('answers 401 INVALID_CREDENTIALS for a wrong password and an unknown user alike', async () => {
    for (const [username, password] of [['sv001', 'wrong-password'], ['khong-ton-tai', TEST_PORTAL_PASSWORD]]) {
      const res = await login(username!, password!).expect(401);

      assert.deepEqual(res.body, { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect.' });
    }
  });

  it('is rate limited per IP with RATE_LIMITED and a readable Retry-After', async () => {
    const ip = '203.0.113.77';

    for (let i = 0; i < 10; i += 1) await login('sv002', 'wrong-password', ip).expect(401);

    const res = await login('sv002', TEST_PORTAL_PASSWORD, ip).set('Origin', 'http://localhost:3000').expect(429);

    assert.equal(res.body.code, 'RATE_LIMITED');
    assert.ok(Number(res.headers['retry-after']) > 0);
    assert.match(res.headers['access-control-expose-headers'] ?? '', /Retry-After/i);
  });

  it('the registrar does not sign in with the public student password', async () => {
    const res = await login('phongdaotao', TEST_PORTAL_PASSWORD).expect(401);

    assert.equal(res.body.code, 'INVALID_CREDENTIALS');
    await login('phongdaotao', TEST_REGISTRAR_PASSWORD).expect(201);
  });

  it(`hashes at most ${MAX_CONCURRENT_HASHES} passwords at once (B-9): the excess is 503 with Retry-After, never queued`, async () => {
    // Twenty unknown users from twenty addresses at the same moment (the per-client limit does not apply).
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => login(`khong-co-${i}`, 'x', `203.0.113.${100 + i}`)));
    const statuses = results.map((r) => r.status);

    console.log(`20 concurrent sign-ins: ${JSON.stringify(statuses.reduce<Record<number, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {}))}`);
    assert.ok(statuses.every((s) => s === 401 || s === 503));
    assert.ok(statuses.filter((s) => s === 401).length >= MAX_CONCURRENT_HASHES);
    assert.ok(statuses.includes(503));
    for (const r of results.filter((r) => r.status === 503)) {
      assert.deepEqual([r.body.code, r.headers['retry-after']], ['UNAVAILABLE', '1']);
    }

    // Afterwards nothing is held: a sign-in works.
    await login('sv001', TEST_PORTAL_PASSWORD).expect(201);
  });

  it(`counts the registrar's wrong passwords per client: an attacker locks out only itself; a backstop of ${REGISTRAR_ACCOUNT_FAILURES} for the account; students never`, async (t) => {
    const redis = app.get(RedisService).getClient();
    const reset = async () => {
      const keys = [...(await redis.keys('state:portal-registrar-failures:*')), ...(await redis.keys('throttle:*'))];

      if (keys.length > 0) await redis.del(...keys);
    };
    // The sign-in limit (10/min per client, 40 per /48) is not what is tested: cleared before a lock is checked.
    const clearRateLimits = async () => {
      const keys = await redis.keys('throttle:*');

      if (keys.length > 0) await redis.del(...keys);
    };
    const isLock = (res: { body: { message: string }; headers: Record<string, string> }) =>
      res.body.message.startsWith('Too many failed sign-ins') && Number(res.headers['retry-after']) > 14 * 60 && Number(res.headers['retry-after']) <= 15 * 60;

    await reset(); // the wrong passwords of the tests above
    t.after(reset); // the other tests sign in as the registrar

    // One IPv4 attacker, within the normal sign-in limit: locked, also with the right password.
    for (let i = 0; i < REGISTRAR_FAILURES; i += 1) await login('phongdaotao', `guess-${i}`, '192.0.2.10').expect(401);
    await clearRateLimits();
    for (const password of ['guess-x', TEST_REGISTRAR_PASSWORD]) {
      const locked = await login('phongdaotao', password, '192.0.2.10').expect(429);

      assert.equal(locked.body.code, 'RATE_LIMITED');
      assert.ok(isLock(locked), `${locked.body.message} ${locked.headers['retry-after']}`);
    }

    // The registrar, from another address, signs in at once.
    assert.equal((await login('phongdaotao', TEST_REGISTRAR_PASSWORD, '198.51.100.20').expect(201)).body.role, 'registrar');

    // An IPv6 attacker spreading over the /56s of one /48: the /48 is locked as a whole (one try per /56).
    for (let i = 0; i < REGISTRAR_FAILURES * NETWORK_SHARES; i += 1) {
      await login('phongdaotao', `guess-${i}`, `2001:db8:9a:${(i << 8).toString(16)}::1`).expect(401);
    }
    await clearRateLimits();
    assert.ok(isLock(await login('phongdaotao', TEST_REGISTRAR_PASSWORD, '2001:db8:9a:ff00::1').expect(429)));
    await login('phongdaotao', TEST_REGISTRAR_PASSWORD, '2001:db8:9b::1').expect(201);

    // The backstop: the account's count from everywhere (seeded one short; 500 sign-ins are slow).
    await redis.set('state:portal-registrar-failures:phongdaotao', String(REGISTRAR_ACCOUNT_FAILURES - 1), 'EX', REGISTRAR_WINDOW_SECONDS);
    await login('phongdaotao', 'guess-last', '198.51.100.21').expect(401);
    assert.ok(isLock(await login('phongdaotao', TEST_REGISTRAR_PASSWORD, '198.51.100.22').expect(429)), 'every client is refused');

    // The public student accounts: three times as many wrong passwords from one address, then the
    // right one from that address works; nothing is counted for them.
    for (let i = 0; i < 3 * REGISTRAR_FAILURES; i += 1) {
      if (i % 10 === 0) await clearRateLimits();
      await login('sv002', `guess-${i}`, '192.0.2.30').expect(401);
    }
    await clearRateLimits();
    await login('sv002', TEST_PORTAL_PASSWORD, '192.0.2.30').expect(201);
    assert.deepEqual(await redis.keys('state:portal-registrar-failures:sv*'), []);

    // Once its window ends the account signs in again.
    await reset();
    await login('phongdaotao', TEST_REGISTRAR_PASSWORD, '192.0.2.10').expect(201);
  });
});

describe('GET /v1/demo/school/credentials', () => {
  const row = (subjectRef: string, issuerName = 'truong-mau', status: 'valid' | 'revoked' = 'valid', portalSessionHash: string | null = null) =>
    prisma.vcIssuedCredential.create({
      data: {
        id: randomBytes(16).toString('base64url'),
        issuerName,
        vct: 'https://identra.awncorp.vn/vct/bang-tot-nghiep/v1',
        subjectRef,
        statusListNumber: 77,
        statusIndex: Math.floor(Math.random() * 131072),
        cnfThumbprint: 'x',
        status,
        portalSessionHash
      }
    });

  it('shows a student session only the diplomas issued in it, and a registrar all of their issuer', async () => {
    const token = await portalLogin(app, 'sv001');
    const session = sessionHashOf(token);
    const mine = [await row('sv001', 'truong-mau', 'valid', session), await row('sv001', 'truong-mau', 'revoked', session)];
    const theirs = await row('sv002');
    const foreign = await row('sv001', 'nha-san-xuat', 'valid', session);
    // The same account, issued in another visitor's session (or before sessions were recorded).
    const otherSession = [await row('sv001', 'truong-mau', 'valid', sessionHashOf(await portalLogin(app, 'sv001'))), await row('sv001')];

    const student = await http().get('/v1/demo/school/credentials').auth(token, { type: 'bearer' }).expect(200);
    const registrar = await http().get('/v1/demo/school/credentials').auth(await portalLogin(app, 'phongdaotao'), { type: 'bearer' }).expect(200);
    const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);

    assert.deepEqual(ids(student.body).sort(), mine.map((m) => m.id).sort());
    assert.ok(ids(registrar.body).includes(theirs.id));
    assert.ok(mine.every((m) => ids(registrar.body).includes(m.id)));
    assert.ok(!ids(registrar.body).includes(foreign.id));
    assert.ok(otherSession.every((o) => ids(registrar.body).includes(o.id)));

    const item = student.body.items.find((i: { id: string }) => i.id === mine[1]!.id);
    assert.deepEqual(item, {
      id: mine[1]!.id,
      studentCode: 'DEMO21CNTT0042',
      studentName: 'Nguyễn Thị Minh Anh',
      issuedAt: mine[1]!.issuedAt.toISOString(),
      status: 'revoked',
      canRevoke: false
    });
    assert.equal(student.body.items.find((i: { id: string }) => i.id === mine[0]!.id).canRevoke, true);
    assert.equal(registrar.body.items.find((i: { id: string }) => i.id === theirs.id).canRevoke, true);
  });

  it('pages newest first with limit and cursor, and scopes names to the issuer (F12)', async () => {
    const before = new Date(Date.now() - 3_600_000);
    const own = [];
    const token = await portalLogin(app, 'sv003');

    for (let i = 0; i < 5; i += 1) {
      own.push(
        await prisma.vcIssuedCredential.create({
          data: {
            id: randomBytes(16).toString('base64url'),
            issuerName: 'truong-mau',
            vct: 'v',
            subjectRef: 'sv003',
            statusListNumber: 78,
            statusIndex: i,
            cnfThumbprint: 'x',
            portalSessionHash: sessionHashOf(token),
            // Two share one instant: the id breaks the tie.
            issuedAt: new Date(before.getTime() - (i < 2 ? 0 : i) * 1000)
          }
        })
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const res: request.Response = await http()
        .get('/v1/demo/school/credentials')
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .auth(token, { type: 'bearer' })
        .expect(200);

      assert.ok(res.body.items.length <= 2);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    assert.equal(pages, 3);
    assert.deepEqual(new Set(seen), new Set(own.map((r) => r.id)));
    assert.equal(seen.length, 5);
    const order = own.sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime() || (b.id < a.id ? -1 : 1)).map((r) => r.id);
    assert.deepEqual(seen, order);

    for (const query of [{ limit: 101 }, { limit: 0 }, { cursor: 'not a cursor!' }, { cursor: 'bm90LWpzb24' }]) {
      const res = await http().get('/v1/demo/school/credentials').query(query).auth(token, { type: 'bearer' }).expect(400);

      assert.equal(res.body.code, 'VALIDATION_FAILED');
    }

    // A row whose subject is an account of ANOTHER issuer gets no name from it.
    const crossed = await row('phongqlcl-nsx');
    const registrar = await http()
      .get('/v1/demo/school/credentials')
      .query({ limit: 100 })
      .auth(await portalLogin(app, 'phongdaotao'), { type: 'bearer' })
      .expect(200);
    const item = registrar.body.items.find((i: { id: string }) => i.id === crossed.id);

    assert.deepEqual([item.studentName, item.studentCode], [null, null]);
  });

  it('needs a live session: 401 SESSION_EXPIRED without one or after it expired', async () => {
    let res = await http().get('/v1/demo/school/credentials').expect(401);
    assert.equal(res.body.code, 'SESSION_EXPIRED');

    const token = await portalLogin(app, 'sv002');
    const key = `state:portal-session:${createHash('sha256').update(token).digest('hex')}`;

    await http().get('/v1/demo/school/credentials').auth(token, { type: 'bearer' }).expect(200);
    await app.get(RedisService).getClient().pexpire(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    res = await http().get('/v1/demo/school/credentials').auth(token, { type: 'bearer' }).expect(401);
    assert.equal(res.body.code, 'SESSION_EXPIRED');
  });
});
