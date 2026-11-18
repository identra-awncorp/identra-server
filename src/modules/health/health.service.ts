import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService
  ) {}

  async check() {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const isHealthy = database.status === 'up' && redis.status === 'up';

    return {
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database,
        redis
      }
    };
  }

  private async checkDatabase() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;

      return { status: 'up' as const };
    } catch {
      // Public endpoint: never echo driver errors (they name hosts and ports).
      return { status: 'down' as const };
    }
  }

  private async checkRedis() {
    try {
      const response = await this.redis.ping();

      return { status: response === 'PONG' ? ('up' as const) : ('degraded' as const) };
    } catch {
      // Public endpoint: never echo driver errors (they name hosts and ports).
      return { status: 'down' as const };
    }
  }
}
