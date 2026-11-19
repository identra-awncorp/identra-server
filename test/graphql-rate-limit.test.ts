// GraphQL's cost limiter (B-8, M6): over budget is HTTP 429 with Retry-After, and an IPv6 /64 is
// one client, as for the REST limits (docs/vc-api.md §8).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createTestApp } from './helpers';

let app: NestExpressApplication;

before(async () => {
  app = await createTestApp({ GRAPHQL_RATE_LIMIT_MAX_COST: '20' });
});

after(async () => {
  await app?.close();
});

const query = (ip: string) => request(app.getHttpServer()).post('/graphql').set('X-Forwarded-For', ip).send({ query: '{ viewer { id } }' });

describe('GraphQL cost rate limit', () => {
  it('answers HTTP 429 with Retry-After past the budget; an IPv6 /64 is one client, another /64 is not', async () => {
    const statuses: number[] = [];

    // A new address of the same /64 every time, until the shared budget is spent.
    for (let i = 1; i <= 50 && statuses.at(-1) !== 429; i += 1) statuses.push((await query(`2001:db8:77:1::${i.toString(16)}`)).status);

    const limited = await query('2001:db8:77:1:ffff::1');
    const other = await query('2001:db8:77:2::1');

    assert.ok(statuses.length > 1 && statuses.slice(0, -1).every((s) => s === 200), JSON.stringify(statuses));
    assert.equal(statuses.at(-1), 429);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.errors[0].extensions.code, 'RATE_LIMITED');
    assert.equal(limited.body.errors[0].extensions.http, undefined);
    assert.ok(Number(limited.headers['retry-after']) > 0, limited.headers['retry-after']);
    assert.equal(other.status, 200);
  });
});
