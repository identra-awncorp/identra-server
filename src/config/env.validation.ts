import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean());

// Development defaults. Production refuses to start while any of these is still in use.
const DEV_SECRET_DEFAULTS = {
  JWT_ACCESS_SECRET: 'dev_access_secret_change_me',
  JWT_REFRESH_SECRET: 'dev_refresh_secret_change_me',
  AUTH_REGISTRATION_TOKEN_SECRET: 'dev_registration_secret_change_me',
  PASSWORD_PEPPER: 'dev_password_pepper_change_me',
  OTP_HMAC_SECRET: 'dev_otp_secret_change_me'
} as const;

const DEV_CORS_ORIGINS = 'http://localhost:3000,http://localhost:8081,http://localhost:19006';
const PRODUCTION_MIN_SECRET_LENGTH = 32;
const PRODUCTION_MIN_DISTINCT_CHARACTERS = 16;
const SECRET_PLACEHOLDER = /change_?me|dev_|secret/i;
// Demo codes anyone would try first.
const GUESSABLE_OTP_CODE = /^(\d)\1{5}$|^123456$/;
const E164 = /^\+[1-9]\d{7,14}$/;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  API_PREFIX: z.string().min(1).default('v1'),
  APP_NAME: z.string().min(1).default('Identra Server'),
  CORS_ORIGINS: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16).default(DEV_SECRET_DEFAULTS.JWT_ACCESS_SECRET),
  JWT_REFRESH_SECRET: z.string().min(16).default(DEV_SECRET_DEFAULTS.JWT_REFRESH_SECRET),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  AUTH_REGISTRATION_TOKEN_SECRET: z.string().min(16).default(DEV_SECRET_DEFAULTS.AUTH_REGISTRATION_TOKEN_SECRET),
  AUTH_REGISTRATION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(8),
  PASSWORD_MAX_LENGTH: z.coerce.number().int().min(64).default(128),
  PASSWORD_PEPPER: z.string().min(16).default(DEV_SECRET_DEFAULTS.PASSWORD_PEPPER),
  PASSWORD_PEPPER_VERSION: z.string().min(1).default('v1'),
  PASSWORD_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PASSWORD_LOCK_SECONDS: z.coerce.number().int().positive().default(900),
  OTP_HMAC_SECRET: z.string().min(16).default(DEV_SECRET_DEFAULTS.OTP_HMAC_SECRET),
  // Fixed demo OTP. Defaults to on outside production and off in production (see validateEnv).
  OTP_DEMO_ENABLED: booleanFromEnv.optional(),
  OTP_DEMO_CODE: z.string().regex(/^\d{6}$/).default('000000'),
  // Comma-separated E.164 numbers that may use the demo OTP. Empty = every number, which
  // production refuses (see productionProblems).
  OTP_DEMO_PHONE_ALLOWLIST: z.string().default(''),
  // Set to `production` by docker-compose.prod.yml so an unset NODE_ENV cannot silently
  // start the VPS in development mode.
  IDENTRA_DEPLOYMENT: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_MAX_STARTS_PER_HOUR: z.coerce.number().int().positive().default(5),
  GRAPHQL_INTROSPECTION: booleanFromEnv.optional(),
  GRAPHQL_GRAPHIQL: booleanFromEnv.optional(),
  GRAPHQL_MAX_DEPTH: z.coerce.number().int().positive().default(8),
  GRAPHQL_MAX_COMPLEXITY: z.coerce.number().int().positive().default(300),
  GRAPHQL_DEFAULT_FIELD_COST: z.coerce.number().int().positive().default(1),
  GRAPHQL_MAX_QUERY_NODES: z.coerce.number().int().positive().default(1000),
  GRAPHQL_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  GRAPHQL_RATE_LIMIT_MAX_COST: z.coerce.number().int().positive().default(1000),
  GRAPHQL_RATE_LIMIT_FAIL_CLOSED: booleanFromEnv.default(false),
  GRAPHQL_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(30),
  GRAPHQL_TRUSTED_DOCUMENTS_ENABLED: booleanFromEnv.default(false),
  GRAPHQL_TRUSTED_DOCUMENT_HASHES: z.string().default('')
});

export type Env = Omit<
  z.infer<typeof envSchema>,
  'CORS_ORIGINS' | 'OTP_DEMO_ENABLED' | 'OTP_DEMO_PHONE_ALLOWLIST'
> & {
  CORS_ORIGINS: string;
  OTP_DEMO_ENABLED: boolean;
  OTP_DEMO_PHONE_ALLOWLIST: string[];
};

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment variables: ${parsed.error.message}`);
  }

  const env = parsed.data;

  if (env.IDENTRA_DEPLOYMENT === 'production' && config.NODE_ENV !== 'production') {
    throw new Error('Refusing to start: IDENTRA_DEPLOYMENT=production requires NODE_ENV=production');
  }

  const isProduction = env.NODE_ENV === 'production';
  const allowlist = splitList(env.OTP_DEMO_PHONE_ALLOWLIST);

  if (allowlist.some((phone) => !E164.test(phone))) {
    throw new Error('Invalid environment variables: OTP_DEMO_PHONE_ALLOWLIST must list E.164 numbers');
  }

  const resolved: Env = {
    ...env,
    CORS_ORIGINS: env.CORS_ORIGINS ?? (isProduction ? '' : DEV_CORS_ORIGINS),
    OTP_DEMO_ENABLED: env.OTP_DEMO_ENABLED ?? !isProduction,
    OTP_DEMO_PHONE_ALLOWLIST: allowlist
  };

  if (isProduction) {
    const problems = productionProblems(resolved, config);

    if (problems.length > 0) {
      // Messages name the variable only, never its value.
      throw new Error(`Refusing to start in production:\n- ${problems.join('\n- ')}`);
    }
  }

  return resolved;
}

function productionProblems(env: Env, raw: Record<string, unknown>): string[] {
  const problems: string[] = [];

  const seen = new Map<string, string>();

  for (const [name, devDefault] of Object.entries(DEV_SECRET_DEFAULTS)) {
    const value = env[name as keyof typeof DEV_SECRET_DEFAULTS];
    const twin = seen.get(value);

    if (value === devDefault) {
      problems.push(`${name} still has its development default`);
    } else if (value.length < PRODUCTION_MIN_SECRET_LENGTH) {
      problems.push(`${name} must be at least ${PRODUCTION_MIN_SECRET_LENGTH} characters`);
    } else if (SECRET_PLACEHOLDER.test(value)) {
      problems.push(`${name} looks like a placeholder (contains change_me, dev_ or secret)`);
    } else if (new Set(value).size < PRODUCTION_MIN_DISTINCT_CHARACTERS) {
      problems.push(
        `${name} must contain at least ${PRODUCTION_MIN_DISTINCT_CHARACTERS} distinct characters`
      );
    } else if (twin) {
      problems.push(`${name} must differ from ${twin}`);
    }

    seen.set(value, name);
  }

  const origins = splitList(env.CORS_ORIGINS);

  if (origins.length === 0 || origins.includes('*')) {
    problems.push('CORS_ORIGINS must list explicit origins (empty and * are not allowed)');
  } else if (!origins.every(isHttpsOrigin)) {
    problems.push('CORS_ORIGINS entries must be https origins without a path (null is not allowed)');
  }

  // The demo OTP only runs in production with an explicit OTP_DEMO_ENABLED=true. Setting
  // OTP_DEMO_CODE without that opt-in is a misconfiguration, not a way to enable it.
  if (!env.OTP_DEMO_ENABLED && raw.OTP_DEMO_CODE !== undefined) {
    problems.push('OTP_DEMO_CODE is set but the demo OTP is not enabled; set OTP_DEMO_ENABLED=true to opt in');
  }

  // Opted in: the code must not be public knowledge and only listed numbers may use it.
  if (env.OTP_DEMO_ENABLED) {
    if (raw.OTP_DEMO_CODE === undefined || GUESSABLE_OTP_CODE.test(env.OTP_DEMO_CODE)) {
      problems.push('OTP_DEMO_CODE must be set to a non-guessable 6-digit code when the demo OTP is enabled');
    }

    if (env.OTP_DEMO_PHONE_ALLOWLIST.length === 0) {
      problems.push('OTP_DEMO_PHONE_ALLOWLIST must list the E.164 numbers allowed to use the demo OTP');
    }
  }

  return problems;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isHttpsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);

    return url.protocol === 'https:' && url.origin === origin;
  } catch {
    return false;
  }
}
