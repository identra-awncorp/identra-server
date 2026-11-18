import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCorsOrigins } from '../src/config/cors';
import { validateEnv } from '../src/config/env.validation';

const strong = (seed: string) => seed.repeat(40).slice(0, 40);

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/identra',
  REDIS_URL: 'redis://redis:6379',
  CORS_ORIGINS: 'https://identra.awncorp.vn',
  JWT_ACCESS_SECRET: strong('a'),
  JWT_REFRESH_SECRET: strong('b'),
  AUTH_REGISTRATION_TOKEN_SECRET: strong('c'),
  PASSWORD_PEPPER: strong('d'),
  OTP_HMAC_SECRET: strong('e')
};

const SECRETS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'AUTH_REGISTRATION_TOKEN_SECRET',
  'PASSWORD_PEPPER',
  'OTP_HMAC_SECRET'
] as const;

describe('production env validation', () => {
  it('accepts a complete production configuration with the demo OTP off by default', () => {
    const env = validateEnv(productionEnv);

    assert.equal(env.OTP_DEMO_ENABLED, false);
    assert.equal(env.CORS_ORIGINS, 'https://identra.awncorp.vn');
  });

  for (const name of SECRETS) {
    it(`refuses a missing (defaulted) ${name}`, () => {
      const { [name]: _omitted, ...env } = productionEnv;

      assert.throws(() => validateEnv(env), new RegExp(`${name} still has its development default`));
    });

    it(`refuses a ${name} shorter than 32 characters without echoing it`, () => {
      const weak = 'short-but-valid-in-dev-x';

      assert.throws(
        () => validateEnv({ ...productionEnv, [name]: weak }),
        (error: Error) =>
          error.message.includes(`${name} must be at least 32 characters`) &&
          !error.message.includes(weak)
      );
    });
  }

  for (const cors of [undefined, '', '  ', '*', 'https://identra.awncorp.vn,*']) {
    it(`refuses CORS_ORIGINS=${JSON.stringify(cors)}`, () => {
      const env: Record<string, unknown> = { ...productionEnv, CORS_ORIGINS: cors };

      assert.throws(() => validateEnv(env), /CORS_ORIGINS must list explicit origins/);
    });
  }

  it('refuses OTP_DEMO_CODE without the explicit OTP_DEMO_ENABLED opt-in', () => {
    assert.throws(
      () => validateEnv({ ...productionEnv, OTP_DEMO_CODE: '123456' }),
      /OTP_DEMO_CODE is set but the demo OTP is not enabled/
    );
  });

  it('allows the demo OTP in production only with OTP_DEMO_ENABLED=true', () => {
    const env = validateEnv({ ...productionEnv, OTP_DEMO_ENABLED: 'true', OTP_DEMO_CODE: '123456' });

    assert.equal(env.OTP_DEMO_ENABLED, true);
  });

  it('keeps development defaults outside production', () => {
    const env = validateEnv({ DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x' });

    assert.equal(env.OTP_DEMO_ENABLED, true);
    assert.equal(env.JWT_ACCESS_SECRET, 'dev_access_secret_change_me');
    assert.ok(env.CORS_ORIGINS.includes('http://localhost:3000'));
  });
});

describe('parseCorsOrigins', () => {
  it('never turns an empty value or * into "allow every origin"', () => {
    assert.deepEqual(parseCorsOrigins(undefined), []);
    assert.deepEqual(parseCorsOrigins(''), []);
    assert.deepEqual(parseCorsOrigins('*'), []);
    assert.deepEqual(parseCorsOrigins(' https://a.example , * ,https://b.example'), [
      'https://a.example',
      'https://b.example'
    ]);
  });
});
