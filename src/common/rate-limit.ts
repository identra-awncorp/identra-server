import {
  ExecutionContext,
  Injectable,
  Module,
  SetMetadata,
  ServiceUnavailableException
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerStorage
} from '@nestjs/throttler';
import Redis from 'ioredis';

import { RedisService } from '../infrastructure/redis/redis.service';
import { normalizePhone } from '../modules/auth/auth.utils';

const MINUTE = 60_000;

/**
 * Per-client-IP limits per route (docs/vc-api.md §8). Every route already gets
 * `default` (300/min); declare a tighter one with `@RateLimit('login')` etc.
 */
export const RATE_LIMITS = {
  default: { limit: 300, ttl: MINUTE },
  login: { limit: 10, ttl: MINUTE },
  sessionCreation: { limit: 30, ttl: MINUTE },
  token: { limit: 20, ttl: MINUTE },
  write: { limit: 60, ttl: MINUTE },
  // Trust list and status lists: many verifiers can share one address, and they are cacheable.
  publicResource: { limit: 1200, ttl: MINUTE }
} as const;

export const RateLimit = (name: keyof typeof RATE_LIMITS) => Throttle({ default: RATE_LIMITS[name] });

const FAIL_CLOSED = 'identra:rate-limit-fail-closed';

/**
 * Without Redis the limits cannot be enforced. Routes marked with this decorator then answer
 * 503 RATE_LIMIT_UNAVAILABLE (fail-closed: used for /v1/auth, where unlimited guessing is
 * worse than an outage); all other routes are served unlimited (fail-open).
 */
export const RateLimitFailClosed = () => SetMetadata(FAIL_CLOSED, true);

class RateLimitStoreUnavailable extends Error {}

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const REDIS_TIMEOUT_MS = 1000;

/** Fixed window per key on Redis INCR + PEXPIRE, shared by every app instance. */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number): Promise<ThrottlerStorageRecord> {
    const redisKey = `throttle:${key}`;
    let timer: NodeJS.Timeout | undefined;

    try {
      // Known to be down: answer at once instead of queueing behind reconnect attempts.
      if (this.redis.status === 'reconnecting' || this.redis.status === 'end') {
        throw new Error('redis down');
      }

      const result = await Promise.race([
        this.redis.multi().incr(redisKey).pexpire(redisKey, ttl, 'NX').pttl(redisKey).exec(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), REDIS_TIMEOUT_MS);
        })
      ]);
      const [[incrError, totalHits], , [, pttl]] = result as [[Error | null, number], unknown, [null, number]];

      if (incrError) {
        throw incrError;
      }

      const timeToExpire = Math.ceil(Math.max(pttl, 0) / 1000);
      const isBlocked = totalHits > limit;

      // Over the limit: blocked until the window ends (no separate block duration).
      return { totalHits, timeToExpire, isBlocked, timeToBlockExpire: isBlocked ? timeToExpire : 0 };
    } catch {
      throw new RateLimitStoreUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

@Injectable()
class AppThrottlerGuard extends ThrottlerGuard {
  // GraphQL has its own cost-based limiter (GraphqlCostRateLimiterService).
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== 'http';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await super.canActivate(context);
    } catch (error) {
      if (!(error instanceof RateLimitStoreUnavailable)) {
        throw error;
      }

      if (this.reflector.getAllAndOverride<boolean>(FAIL_CLOSED, [context.getHandler(), context.getClass()])) {
        throw new ServiceUnavailableException({
          code: 'RATE_LIMIT_UNAVAILABLE',
          message: 'Temporarily unavailable. Please try again later.'
        });
      }

      return true;
    }
  }
}

// Second, per-phone budget for bodies that carry a phone number (auth start/verify/login):
// rotating IPs does not buy more guesses against one account.
function phoneOf(context: ExecutionContext): string | null {
  const phone = context.switchToHttp().getRequest<{ body?: { phone?: unknown } }>().body?.phone;

  if (typeof phone !== 'string') {
    return null;
  }

  try {
    return normalizePhone(phone);
  } catch {
    return phone.trim();
  }
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        storage: new RedisThrottlerStorage(redis.getClient()),
        throttlers: [
          { name: 'default', ...RATE_LIMITS.default },
          {
            name: 'phone',
            ...RATE_LIMITS.login,
            skipIf: (context) => context.getType() !== 'http' || phoneOf(context) === null,
            getTracker: (_req, context) => `phone:${phoneOf(context)}`
          }
        ]
      })
    })
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }]
})
export class RateLimitModule {}
