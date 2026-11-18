import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../src/infrastructure/redis/redis.service';
import { createTestApp, portalLogin, randomIp, seedPortalAccounts, TEST_PORTAL_PASSWORD } from './helpers';

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

  it('refuses to run without DEMO_PORTAL_PASSWORD', () => {
    const { DEMO_PORTAL_PASSWORD: _unset, ...env } = process.env;

    assert.throws(() => execFileSync(process.execPath, [script], { env, stdio: 'pipe' }), /refuses to run/);
  });

  it('upserts the four sample accounts, idempotently, and nothing else', async (t) => {
    t.after(() => seedPortalAccounts(prisma)); // back to the test password, even on failure
    const usersBefore = await prisma.user.count();
    const env = { ...process.env, DEMO_PORTAL_PASSWORD: 'Another-Pass-2026' };

    execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
    const output = execFileSync(process.execPath, [script], { env, stdio: 'pipe' }).toString();

    assert.match(output, /sv001 \(student\)[\s\S]*phongdaotao \(registrar\)/);
    assert.ok(!output.includes('Another-Pass-2026'));
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
});

describe('GET /v1/demo/school/credentials', () => {
  const row = (subjectRef: string, issuerName = 'truong-mau', status: 'valid' | 'revoked' = 'valid') =>
    prisma.vcIssuedCredential.create({
      data: {
        id: randomBytes(16).toString('base64url'),
        issuerName,
        vct: 'https://identra.awncorp.vn/vct/bang-tot-nghiep/v1',
        subjectRef,
        statusListNumber: 77,
        statusIndex: Math.floor(Math.random() * 131072),
        cnfThumbprint: 'x',
        status
      }
    });

  it('shows a student only their own diplomas and a registrar all of their issuer', async () => {
    const mine = [await row('sv001'), await row('sv001', 'truong-mau', 'revoked')];
    const theirs = await row('sv002');
    const foreign = await row('sv001', 'nha-san-xuat');

    const student = await http().get('/v1/demo/school/credentials').auth(await portalLogin(app, 'sv001'), { type: 'bearer' }).expect(200);
    const registrar = await http().get('/v1/demo/school/credentials').auth(await portalLogin(app, 'phongdaotao'), { type: 'bearer' }).expect(200);
    const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);

    assert.deepEqual(ids(student.body).sort(), mine.map((m) => m.id).sort());
    assert.ok(ids(registrar.body).includes(theirs.id));
    assert.ok(mine.every((m) => ids(registrar.body).includes(m.id)));
    assert.ok(!ids(registrar.body).includes(foreign.id));

    const item = student.body.items.find((i: { id: string }) => i.id === mine[1]!.id);
    assert.deepEqual(item, {
      id: mine[1]!.id,
      studentCode: 'DEMO21CNTT0042',
      studentName: 'Nguyễn Thị Minh Anh',
      issuedAt: mine[1]!.issuedAt.toISOString(),
      status: 'revoked'
    });
  });

  it('pages newest first with limit and cursor, and scopes names to the issuer (F12)', async () => {
    const before = new Date(Date.now() - 3_600_000);
    const own = [];

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
            // Two share one instant: the id breaks the tie.
            issuedAt: new Date(before.getTime() - (i < 2 ? 0 : i) * 1000)
          }
        })
      );
    }

    const token = await portalLogin(app, 'sv003');
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
