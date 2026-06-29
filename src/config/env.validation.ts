import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().min(1).default('v1'),
  APP_NAME: z.string().min(1).default('Identra Server'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:8081,http://localhost:19006'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev_access_secret_change_me'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev_refresh_secret_change_me')
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment variables: ${parsed.error.message}`);
  }

  return parsed.data;
}
