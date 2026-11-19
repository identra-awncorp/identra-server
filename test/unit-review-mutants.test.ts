// Unit tests for the reviewer's surviving mutants that need no app: the verifier's 30 s retry
// (M7) and the dependency-down mapping (M11, B-7).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '@prisma/client';

import { isDependencyDown } from '../src/common/http-errors';
import { HOSTED_VERIFIERS } from '../src/vc/hosted-issuers';
import { createHostedVerifiers, VERIFIER_RETRY_MS } from '../src/vc/verifiers';

describe('a verifier that could not be built (M7)', () => {
  it('is retried after VERIFIER_RETRY_MS on the same trust list, not before; a new list retries at once', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

    let builds = 0;
    let token = 'trust-list-1';
    const verifiers = createHostedVerifiers({
      // The build fails at the signer: no key material is needed to count the attempts.
      pki: { unavailable: new Set(), keyStore: { signer: async () => (builds++, Promise.reject(new Error('no request key'))) } } as never,
      clock: { now: () => new Date() },
      trustList: { token: async () => token } as never,
      trustRegistry: {} as never,
      statusChecker: {} as never,
      redis: { getClient: () => ({}) } as never
    });
    const name = HOSTED_VERIFIERS[0]!.name;

    assert.equal(await verifiers.available(name), null);
    assert.equal(builds, 1);
    t.mock.timers.tick(VERIFIER_RETRY_MS - 1);
    assert.equal(await verifiers.available(name), null);
    assert.equal(builds, 1, 'not retried within the period');
    t.mock.timers.tick(1);
    assert.equal(await verifiers.available(name), null);
    assert.equal(builds, 2, 'retried once the period has passed');
    token = 'trust-list-2';
    assert.equal(await verifiers.available(name), null);
    assert.equal(builds, 3, 'a newly signed trust list is tried at once');
    assert.equal(await verifiers.check(), 'down');
  });
});

describe('dependency failures are 503, not 500 (M11, B-7)', () => {
  const redisReply = (message: string) => Object.assign(new Error(message), { name: 'ReplyError' });

  it('maps the ioredis failures and the refusing Redis replies', () => {
    for (const message of [
      'Command timed out',
      'Connection is closed.',
      "Stream isn't writeable and enableOfflineQueue options is false",
      'OOM command not allowed when used memory > maxmemory.',
      'MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on disk.',
      'LOADING Redis is loading the dataset in memory',
      "READONLY You can't write against a read only replica."
    ]) {
      assert.equal(isDependencyDown(redisReply(message)), true, message);
    }

    assert.equal(isDependencyDown(Object.assign(new Error('x'), { name: 'MaxRetriesPerRequestError' })), true);
    assert.equal(isDependencyDown(redisReply('WRONGTYPE Operation against a key holding the wrong kind of value')), false);
    assert.equal(isDependencyDown(new Error('something else')), false);
  });

  it('maps the Prisma connection-class failures and unknown request errors', () => {
    const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '6' });

    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2037']) assert.equal(isDependencyDown(known(code)), true, code);
    assert.equal(isDependencyDown(known('P2002')), false);
    const unknown = (message: string) => new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: '6' });

    assert.equal(isDependencyDown(unknown('db error: FATAL: terminating connection due to administrator command, Code: `57P01`')), true);
    assert.equal(isDependencyDown(unknown('Error { kind: Closed, cause: None }')), true);
    assert.equal(isDependencyDown(unknown('the database system is starting up, Code: `57P03`')), true);
    // A genuine failure (a raising trigger) stays a 500.
    assert.equal(isDependencyDown(unknown("ERROR: injected failure, Code: `P0001`")), false);
    assert.equal(isDependencyDown(new Prisma.PrismaClientInitializationError("Can't reach database server", '6')), true);
  });
});
