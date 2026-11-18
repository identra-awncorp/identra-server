import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { createTestApp, registerUser, RegisteredUser, TEST_PASSWORD } from './helpers';

let app: NestExpressApplication;
let alice: RegisteredUser;
let bob: RegisteredUser;
const credentialIds: Record<string, string> = {};

async function giveCredentialAndActivity(prisma: PrismaService, user: RegisteredUser, tag: string) {
  const credential = await prisma.credential.create({
    data: {
      holderId: user.id,
      type: 'StudentCard',
      title: `credential-${tag}`,
      claims: {},
      attributes: {
        create: [
          { label: 'name', value: `name-${tag}` },
          { label: 'nationalId', value: `secret-${tag}`, isSensitive: true }
        ]
      }
    }
  });
  credentialIds[tag] = credential.id;

  await prisma.activityLog.create({
    data: { userId: user.id, type: 'ADD', title: `activity-${tag}`, description: 'x', partner: 'x' }
  });
}

before(async () => {
  app = await createTestApp();
  alice = await registerUser(app);
  bob = await registerUser(app);

  const prisma = app.get(PrismaService);
  await giveCredentialAndActivity(prisma, alice, 'alice');
  await giveCredentialAndActivity(prisma, bob, 'bob');
});

after(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());

describe('REST endpoints require a valid access token', () => {
  for (const path of ['/v1/users/me', '/v1/credentials', '/v1/audit/activity']) {
    it(`GET ${path} without a token is 401 ACCESS_TOKEN_REQUIRED`, async () => {
      const res = await http().get(path).expect(401);

      assert.equal(res.body.code, 'ACCESS_TOKEN_REQUIRED');
    });

    it(`GET ${path} with a forged token is 401 ACCESS_TOKEN_INVALID`, async () => {
      const res = await http().get(path).set('Authorization', 'Bearer not.a.jwt').expect(401);

      assert.equal(res.body.code, 'ACCESS_TOKEN_INVALID');
    });
  }

  it('GET /v1/users/me returns the caller, not the first user', async () => {
    const asAlice = await http().get('/v1/users/me').auth(alice.accessToken, { type: 'bearer' }).expect(200);
    const asBob = await http().get('/v1/users/me').auth(bob.accessToken, { type: 'bearer' }).expect(200);

    assert.equal(asAlice.body.data.id, alice.id);
    assert.equal(asAlice.body.data.phone, alice.phone);
    assert.equal(asBob.body.data.id, bob.id);
  });

  it('GET /v1/credentials returns only the caller credentials', async () => {
    const res = await http().get('/v1/credentials').auth(alice.accessToken, { type: 'bearer' }).expect(200);

    assert.deepEqual(
      res.body.data.map((c: { title: string }) => c.title),
      ['credential-alice']
    );
  });

  it('GET /v1/audit/activity returns only the caller entries', async () => {
    const res = await http().get('/v1/audit/activity').auth(bob.accessToken, { type: 'bearer' }).expect(200);

    assert.ok(res.body.data.length > 0);
    assert.ok(res.body.data.every((entry: { userId: string }) => entry.userId === bob.id));
  });

  it('a revoked session is refused with 401 SESSION_REVOKED_OR_EXPIRED', async () => {
    const carol = await registerUser(app);
    await http().post('/v1/auth/logout').auth(carol.accessToken, { type: 'bearer' }).send({}).expect(201);

    const res = await http().get('/v1/users/me').auth(carol.accessToken, { type: 'bearer' }).expect(401);
    assert.equal(res.body.code, 'SESSION_REVOKED_OR_EXPIRED');
  });

  it('the guarded auth endpoints keep their contract (GET /v1/auth/devices)', async () => {
    await http().get('/v1/auth/devices').expect(401);
    const res = await http().get('/v1/auth/devices').auth(alice.accessToken, { type: 'bearer' }).expect(200);

    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].current, true);
  });
});

describe('GraphQL identity comes only from a verified JWT', () => {
  // Every header the old context trusted, claiming to be Bob with full privileges.
  const spoofedHeaders = () => ({
    'x-identra-user-id': bob.id,
    'x-identra-role': 'admin',
    'x-identra-scopes':
      'identity:read identity:sensitive:read credentials:read credentials:sensitive:read session:high_assurance',
    'x-identra-session-assurance': 'high'
  });

  const gql = (query: string, variables: Record<string, unknown> = {}) =>
    http().post('/graphql').set('Content-Type', 'application/json').send({ query, variables });

  it('anonymous viewer is null even with spoofed headers (no first-user fallback)', async () => {
    const res = await gql('{ viewer { id } }').set(spoofedHeaders()).expect(200);

    assert.equal(res.body.data.viewer, null);
  });

  it('spoofed headers do not grant access to another user credential', async () => {
    const res = await gql('query($id: String!) { credential(id: $id) { id } }', { id: credentialIds.bob })
      .set(spoofedHeaders())
      .expect(200);

    assert.equal(res.body.data?.credential ?? null, null);
    assert.ok(res.body.errors?.length, 'expected a forbidden error');
  });

  it('an authenticated caller stays themselves despite spoofed headers', async () => {
    const res = await gql(
      `query($bobCredential: String!) {
        viewer { id phone credentials { id attributes { label value } } }
        other: credential(id: $bobCredential) { id }
      }`,
      { bobCredential: credentialIds.bob }
    )
      .set(spoofedHeaders())
      .auth(alice.accessToken, { type: 'bearer' })
      .expect(200);

    assert.equal(res.body.data.viewer.id, alice.id);
    assert.equal(res.body.data.viewer.phone, alice.phone);
    assert.deepEqual(
      res.body.data.viewer.credentials.map((c: { id: string }) => c.id),
      [credentialIds.alice]
    );
    // High assurance cannot be claimed by header: the sensitive attribute stays hidden.
    const attributes = res.body.data.viewer.credentials[0].attributes;
    assert.deepEqual(attributes.find((a: { label: string }) => a.label === 'nationalId').value, null);
    assert.equal(attributes.find((a: { label: string }) => a.label === 'name').value, 'name-alice');
    assert.equal(res.body.data.other, null);
    assert.ok(res.body.errors?.length, 'expected a forbidden error for Bob credential');
  });

  it('an invalid bearer token is rejected with 401 UNAUTHENTICATED', async () => {
    const res = await gql('{ viewer { id } }').set('Authorization', `Bearer ${randomBytes(8).toString('hex')}`);

    assert.equal(res.status, 401);
    assert.equal(res.body.errors[0].extensions.code, 'UNAUTHENTICATED');
  });
});

describe('an access token belongs to one login (F1)', () => {
  it('a token from before logout stays dead after the next login on the same device', async () => {
    const dave = await registerUser(app);
    const oldToken = dave.accessToken;

    await http().get('/v1/users/me').auth(oldToken, { type: 'bearer' }).expect(200);
    await http().post('/v1/auth/logout').auth(oldToken, { type: 'bearer' }).send({}).expect(201);
    await http().get('/v1/users/me').auth(oldToken, { type: 'bearer' }).expect(401);

    // Same trusted device: password only, the same DeviceSession row is reused.
    const login = await http()
      .post('/v1/auth/login/start')
      .send({ phone: dave.phone, password: TEST_PASSWORD, device: dave.device })
      .expect(201);
    const newToken = login.body.data.tokens.accessToken;

    const rest = await http().get('/v1/users/me').auth(oldToken, { type: 'bearer' }).expect(401);
    assert.equal(rest.body.code, 'SESSION_REVOKED_OR_EXPIRED');

    const graphql = await http()
      .post('/graphql')
      .auth(oldToken, { type: 'bearer' })
      .send({ query: '{ viewer { id } }' });
    assert.equal(graphql.status, 401);

    const fresh = await http().get('/v1/users/me').auth(newToken, { type: 'bearer' }).expect(200);
    assert.equal(fresh.body.data.id, dave.id);
  });

  it('the access token carries no phone number', () => {
    const claims = app.get(JwtService, { strict: false }).decode(alice.accessToken);

    assert.equal(claims.phone, undefined);
    assert.equal(JSON.stringify(claims).includes(alice.phone.slice(1)), false);
  });
});

describe('access-token verification (F7)', () => {
  const jwt = () => app.get(JwtService, { strict: false });
  const secret = () => app.get(ConfigService).getOrThrow<string>('JWT_ACCESS_SECRET');
  const claimsOf = (token: string) => {
    const { iat: _iat, exp: _exp, ...claims } = jwt().decode(token);

    return claims;
  };
  const meWith = (token: string) => http().get('/v1/users/me').auth(token, { type: 'bearer' });

  it('accepts a correctly re-signed token (control for the cases below)', async () => {
    const token = jwt().sign(claimsOf(alice.accessToken), { secret: secret(), expiresIn: 300 });

    await meWith(token).expect(200);
  });

  const cases: Array<[string, () => string]> = [
    ['signed with HS512', () =>
      jwt().sign(claimsOf(alice.accessToken), { secret: secret(), algorithm: 'HS512', expiresIn: 300 })],
    ['without exp', () => jwt().sign(claimsOf(alice.accessToken), { secret: secret() })],
    ['expired', () =>
      jwt().sign({ ...claimsOf(alice.accessToken), exp: Math.floor(Date.now() / 1000) - 10 }, { secret: secret() })],
    ['with token_use other than access', () =>
      jwt().sign({ ...claimsOf(alice.accessToken), token_use: 'refresh' }, { secret: secret(), expiresIn: 300 })],
    ['without lid', () => {
      const { lid: _lid, ...claims } = claimsOf(alice.accessToken);

      return jwt().sign(claims, { secret: secret(), expiresIn: 300 });
    }],
    ['signed with another secret', () =>
      jwt().sign(claimsOf(alice.accessToken), { secret: randomBytes(32).toString('hex'), expiresIn: 300 })]
  ];

  for (const [name, makeToken] of cases) {
    it(`refuses a token ${name} with 401 ACCESS_TOKEN_INVALID`, async () => {
      const res = await meWith(makeToken()).expect(401);

      assert.equal(res.body.code, 'ACCESS_TOKEN_INVALID');
    });
  }
});
