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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  API_PREFIX: z.string().min(1).default('v1'),
  APP_NAME: z.string().min(1).default('Identra Server'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:8081,http://localhost:19006'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev_access_secret_change_me'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev_refresh_secret_change_me'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  AUTH_REGISTRATION_TOKEN_SECRET: z.string().min(16).default('dev_registration_secret_change_me'),
  AUTH_REGISTRATION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(8),
  PASSWORD_MAX_LENGTH: z.coerce.number().int().min(64).default(128),
  PASSWORD_PEPPER: z.string().min(16).default('dev_password_pepper_change_me'),
  PASSWORD_PEPPER_VERSION: z.string().min(1).default('v1'),
  PASSWORD_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PASSWORD_LOCK_SECONDS: z.coerce.number().int().positive().default(900),
  OTP_HMAC_SECRET: z.string().min(16).default('dev_otp_secret_change_me'),
  OTP_DEMO_CODE: z.string().regex(/^\d{6}$/).default('000000'),
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

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment variables: ${parsed.error.message}`);
  }

  return parsed.data;
}
