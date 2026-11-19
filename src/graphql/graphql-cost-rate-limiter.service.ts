import { Injectable } from '@nestjs/common';
import { GraphQLError } from 'graphql';

import { RedisService } from '../infrastructure/redis/redis.service';
import { GraphqlContext } from './graphql.context';
import { GraphqlSecurityConfig } from './graphql-security.config';

interface Bucket {
  used: number;
  resetAt: number;
}

interface RateLimitResult {
  limit: number;
  used: number;
  remaining: number;
  resetAt: Date;
}

@Injectable()
export class GraphqlCostRateLimiterService {
  private readonly memoryBuckets = new Map<string, Bucket>();

  constructor(
    private readonly redis: RedisService,
    private readonly securityConfig: GraphqlSecurityConfig
  ) {}

  async consume(context: GraphqlContext, cost: number): Promise<RateLimitResult> {
    const windowSeconds = this.securityConfig.rateLimitWindowSeconds;
    const limit = this.securityConfig.rateLimitMaxCost;
    const bucketId = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `graphql:cost:${context.identity.rateLimitKey}:${bucketId}`;

    try {
      const client = this.redis.getClient();
      const used = await client.incrby(key, cost);

      if (used === cost) {
        await client.expire(key, windowSeconds);
      }

      return assertWithinLimit(limit, used, windowSeconds);
    } catch (error) {
      if (error instanceof GraphQLError) {
        throw error;
      }

      if (this.securityConfig.rateLimitFailClosed) {
        throw new GraphQLError('GraphQL cost rate limiter is unavailable.', {
          extensions: {
            code: 'RATE_LIMITER_UNAVAILABLE',
            http: { status: 503, headers: new Map([['retry-after', '5']]) }
          }
        });
      }

      return this.consumeInMemory(key, cost, limit, windowSeconds);
    }
  }

  private consumeInMemory(
    key: string,
    cost: number,
    limit: number,
    windowSeconds: number
  ): RateLimitResult {
    const now = Date.now();
    const existing = this.memoryBuckets.get(key);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : {
            used: 0,
            resetAt: now + windowSeconds * 1000
          };

    bucket.used += cost;
    this.memoryBuckets.set(key, bucket);

    return assertWithinLimit(limit, bucket.used, Math.ceil((bucket.resetAt - now) / 1000));
  }
}

function assertWithinLimit(limit: number, used: number, resetInSeconds: number): RateLimitResult {
  const remaining = Math.max(limit - used, 0);
  const resetAt = new Date(Date.now() + resetInSeconds * 1000);

  if (used > limit) {
    throw new GraphQLError('GraphQL cost rate limit exceeded.', {
      extensions: {
        code: 'RATE_LIMITED',
        limit,
        used,
        remaining,
        resetAt: resetAt.toISOString(),
        // Apollo answers with this HTTP status and header (and drops `http` from the body).
        http: { status: 429, headers: new Map([['retry-after', String(Math.max(1, resetInSeconds))]]) }
      }
    });
  }

  return {
    limit,
    used,
    remaining,
    resetAt
  };
}
