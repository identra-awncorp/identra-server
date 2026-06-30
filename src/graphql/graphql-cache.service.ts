import { Injectable } from '@nestjs/common';

import { RedisService } from '../infrastructure/redis/redis.service';
import { GraphqlSecurityConfig } from './graphql-security.config';

interface InMemoryCacheEntry {
  expiresAt: number;
  value: unknown;
}

@Injectable()
export class GraphqlCacheService {
  private readonly memoryCache = new Map<string, InMemoryCacheEntry>();

  constructor(
    private readonly redis: RedisService,
    private readonly securityConfig: GraphqlSecurityConfig
  ) {}

  async getOrSet<T>(key: string, loader: () => Promise<T>, ttlSeconds = this.securityConfig.cacheTtlSeconds): Promise<T> {
    if (ttlSeconds <= 0) {
      return loader();
    }

    const redisKey = `graphql:cache:${key}`;
    const fromMemory = this.getFromMemory<T>(redisKey);

    if (fromMemory !== undefined) {
      return fromMemory;
    }

    try {
      const client = this.redis.getClient();
      const cached = await client.get(redisKey);

      if (cached) {
        const parsed = JSON.parse(cached) as T;
        this.setMemory(redisKey, parsed, ttlSeconds);

        return parsed;
      }

      const fresh = await loader();
      await client.set(redisKey, JSON.stringify(fresh), 'EX', ttlSeconds);
      this.setMemory(redisKey, fresh, ttlSeconds);

      return fresh;
    } catch {
      const fresh = await loader();
      this.setMemory(redisKey, fresh, ttlSeconds);

      return fresh;
    }
  }

  private getFromMemory<T>(key: string): T | undefined {
    const entry = this.memoryCache.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);

      return undefined;
    }

    return entry.value as T;
  }

  private setMemory<T>(key: string, value: T, ttlSeconds: number): void {
    this.memoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000
    });
  }
}
