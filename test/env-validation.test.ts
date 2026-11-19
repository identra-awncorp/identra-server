import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCorsOrigins } from '../src/config/cors';
import { validateEnv } from '../src/config/env.validation';
import { productionEnv as strongProductionEnv } from './helpers';

const productionEnv = {
  ...strongProductionEnv('/run/identra/keys'),
  DATABASE_URL: 'postgresql://u:p@db:5432/identra',
  REDIS_URL: 'redis://redis:6379'
};

const SECRETS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'AUTH_REGISTRATION_TOKEN_SECRET',
  'PASSWORD_PEPPER',
  'OTP_HMAC_SECRET'
] as const;

const demoOtpOptIn = {
  OTP_DEMO_ENABLED: 'true',
  OTP_DEMO_CODE: '580274',
  OTP_DEMO_PHONE_ALLOWLIST: '+84900000001, +84900000002'
};

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

    it(`refuses a ${name} with fewer than 16 distinct characters`, () => {
      assert.throws(
        () => validateEnv({ ...productionEnv, [name]: 'abcdefgh'.repeat(6) }),
        new RegExp(`${name} must contain at least 16 distinct characters`)
      );
    });

    for (const placeholder of ['change_me', 'dev_', 'Secret']) {
      it(`refuses a ${name} containing "${placeholder}"`, () => {
        const value = `${placeholder}${productionEnv[name]}`;

        assert.throws(() => validateEnv({ ...productionEnv, [name]: value }), new RegExp(`${name} looks like a placeholder`));
      });
    }
  }

  it('refuses two secrets with the same value', () => {
    assert.throws(
      () => validateEnv({ ...productionEnv, PASSWORD_PEPPER: productionEnv.JWT_ACCESS_SECRET }),
      /PASSWORD_PEPPER must differ from JWT_ACCESS_SECRET/
    );
  });

  for (const cors of [undefined, '', '  ', '*', 'https://identra.awncorp.vn,*']) {
    it(`refuses CORS_ORIGINS=${JSON.stringify(cors)}`, () => {
      const env: Record<string, unknown> = { ...productionEnv, CORS_ORIGINS: cors };

      assert.throws(() => validateEnv(env), /CORS_ORIGINS must list explicit origins/);
    });
  }

  for (const cors of ['null', 'http://identra.awncorp.vn', 'https://identra.awncorp.vn/app', 'identra.awncorp.vn']) {
    it(`refuses the non-https or malformed origin ${cors}`, () => {
      assert.throws(
        () => validateEnv({ ...productionEnv, CORS_ORIGINS: `https://ok.example,${cors}` }),
        /CORS_ORIGINS entries must be https origins/
      );
    });
  }

  it('refuses IDENTRA_DEPLOYMENT=production without NODE_ENV=production', () => {
    const { NODE_ENV: _unset, ...env } = productionEnv;

    assert.throws(() => validateEnv({ ...env, IDENTRA_DEPLOYMENT: 'production' }), /requires NODE_ENV=production/);
    assert.throws(
      () => validateEnv({ ...env, NODE_ENV: 'development', IDENTRA_DEPLOYMENT: 'production' }),
      /requires NODE_ENV=production/
    );
    assert.equal(validateEnv({ ...productionEnv, IDENTRA_DEPLOYMENT: 'production' }).NODE_ENV, 'production');
  });

  it('refuses OTP_DEMO_CODE without the explicit OTP_DEMO_ENABLED opt-in', () => {
    assert.throws(
      () => validateEnv({ ...productionEnv, OTP_DEMO_CODE: '580274' }),
      /OTP_DEMO_CODE is set but the demo OTP is not enabled/
    );
  });

  it('allows the demo OTP in production with a private code and an allowlist', () => {
    const env = validateEnv({ ...productionEnv, ...demoOtpOptIn });

    assert.equal(env.OTP_DEMO_ENABLED, true);
    assert.deepEqual(env.OTP_DEMO_PHONE_ALLOWLIST, ['+84900000001', '+84900000002']);
  });

  for (const code of [undefined, '000000', '123456', '777777']) {
    it(`refuses the demo OTP in production with OTP_DEMO_CODE=${code}`, () => {
      const env: Record<string, unknown> = { ...productionEnv, ...demoOtpOptIn, OTP_DEMO_CODE: code };

      assert.throws(() => validateEnv(env), /OTP_DEMO_CODE must be set to a non-guessable 6-digit code/);
    });
  }

  it('refuses the demo OTP in production without OTP_DEMO_PHONE_ALLOWLIST', () => {
    assert.throws(
      () => validateEnv({ ...productionEnv, ...demoOtpOptIn, OTP_DEMO_PHONE_ALLOWLIST: '' }),
      /OTP_DEMO_PHONE_ALLOWLIST must list the E.164 numbers/
    );
  });

  it('refuses allowlist entries that are not E.164', () => {
    assert.throws(
      () => validateEnv({ ...productionEnv, ...demoOtpOptIn, OTP_DEMO_PHONE_ALLOWLIST: '0900000001' }),
      /OTP_DEMO_PHONE_ALLOWLIST must list E.164 numbers/
    );
  });

  it('keeps development defaults outside production', () => {
    const env = validateEnv({ DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x' });

    assert.equal(env.OTP_DEMO_ENABLED, true);
    assert.equal(env.JWT_ACCESS_SECRET, 'dev_access_secret_change_me');
    assert.deepEqual(env.OTP_DEMO_PHONE_ALLOWLIST, []);
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

describe('credential feature configuration', () => {
  const dev = { DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x' };

  it('defaults to the canonical base URL and derives the trust-list source from the keys dir', () => {
    const env = validateEnv({ ...dev, IDENTRA_KEYS_DIR: '/keys' });

    assert.equal(env.IDENTRA_PUBLIC_BASE_URL, 'https://api-identra.awncorp.vn');
    assert.equal(env.IDENTRA_TRUST_LIST_SOURCE, '/keys/trust-list.source.json');
    assert.deepEqual(env.IDENTRA_ORG_API_KEY_HASHES, []);
  });

  for (const url of ['http://api-identra.awncorp.vn', 'https://api-identra.awncorp.vn/', 'https://x.example/api']) {
    it(`refuses IDENTRA_PUBLIC_BASE_URL=${url}`, () => {
      assert.throws(() => validateEnv({ ...dev, IDENTRA_PUBLIC_BASE_URL: url }), /IDENTRA_PUBLIC_BASE_URL must be an https origin/);
    });
  }

  it('refuses a non-canonical base URL in production unless explicitly overridden', () => {
    const env = { ...productionEnv, IDENTRA_PUBLIC_BASE_URL: 'https://staging.example' };

    assert.throws(() => validateEnv(env), /IDENTRA_PUBLIC_BASE_URL must be https:\/\/api-identra\.awncorp\.vn/);
    assert.equal(
      validateEnv({ ...env, IDENTRA_ALLOW_NONCANONICAL_BASE_URL: 'true' }).IDENTRA_PUBLIC_BASE_URL,
      'https://staging.example'
    );
  });

  it('requires IDENTRA_KEYS_DIR in production', () => {
    const { IDENTRA_KEYS_DIR: _unset, ...env } = productionEnv;

    assert.throws(() => validateEnv(env), /IDENTRA_KEYS_DIR is required/);
  });

  it('refuses relative key and source paths', () => {
    assert.throws(() => validateEnv({ ...dev, IDENTRA_KEYS_DIR: 'keys' }), /IDENTRA_KEYS_DIR must be an absolute path/);
    assert.throws(() => validateEnv({ ...dev, IDENTRA_TRUST_LIST_SOURCE: './x.json' }), /IDENTRA_TRUST_LIST_SOURCE must be an absolute path/);
  });

  it('parses IDENTRA_ORG_API_KEY_HASHES and refuses malformed entries without echoing them', () => {
    const hash = 'a'.repeat(64);

    assert.deepEqual(validateEnv({ ...dev, IDENTRA_ORG_API_KEY_HASHES: `truong-mau:${hash}, kiem-dinh:${'b'.repeat(64)}` }).IDENTRA_ORG_API_KEY_HASHES, [
      { org: 'truong-mau', hash },
      { org: 'kiem-dinh', hash: 'b'.repeat(64) }
    ]);

    for (const bad of [`Truong:${hash}`, 'truong-mau:abc', `truong-mau:${hash}:x`, 'plainsecretvalue']) {
      assert.throws(
        () => validateEnv({ ...dev, IDENTRA_ORG_API_KEY_HASHES: bad }),
        (error: Error) => /org:sha256hex/.test(error.message) && !error.message.includes(bad)
      );
    }
  });

  it('refuses a key hash listed twice and an organisation that is not hosted, without echoing them (N7)', () => {
    const hash = 'c'.repeat(64);

    for (const [bad, message] of [
      [`truong-mau:${hash},kiem-dinh:${hash}`, /same key hash twice/],
      [`truong-mau:${hash},truong-mau:${hash}`, /same key hash twice/],
      [`truong-mua:${hash}`, /not a hosted issuer/],
      [`nha-tuyen-dung-mau:${hash}`, /not a hosted issuer/]
    ] as const) {
      assert.throws(
        () => validateEnv({ ...dev, IDENTRA_ORG_API_KEY_HASHES: bad }),
        (error: Error) => message.test(error.message) && !error.message.includes(hash) && !error.message.includes('truong-mua'),
        bad
      );
    }
  });

  it('defaults the protocol-state caps of docs/vc-api.md §8', () => {
    const env = validateEnv({ ...dev });

    assert.deepEqual(
      [env.VERIFICATION_MAX_LIVE_SESSIONS, env.VERIFICATION_SESSIONS_PER_MINUTE, env.ISSUANCE_MAX_LIVE_NONCES, env.ISSUANCE_MAX_LIVE_OFFERS],
      [2000, 300, 2000, 500]
    );
  });
});
