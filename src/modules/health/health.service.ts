import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import type { TrustListService } from '../../sdk.mjs';
import { TRUST_LIST_SERVICE } from '../../vc/vc.providers';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly moduleRef: ModuleRef
  ) {}

  async check() {
    const [database, redis, trustList] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkTrustList()
    ]);
    // `status` (the container healthcheck) follows the stores only: a broken trust-list source
    // must not make Docker restart the api. Monitoring watches `trustList` (ADR-0014 §7).
    const isHealthy = database.status === 'up' && redis.status === 'up';

    return {
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database,
        redis,
        ...(trustList ? { trustList } : {})
      }
    };
  }

  /** Only when the credential features are on: can a valid trust list be served right now? */
  private async checkTrustList() {
    let service: TrustListService;

    try {
      service = this.moduleRef.get<TrustListService>(TRUST_LIST_SERVICE, { strict: false });
    } catch {
      return null;
    }

    return service
      .token()
      .then(() => ({ status: 'up' as const }))
      .catch(() => ({ status: 'down' as const }));
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
