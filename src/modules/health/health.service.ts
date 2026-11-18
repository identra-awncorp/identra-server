import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { TRUST_LIST_MONITOR, TrustListMonitor } from '../../vc/trust-list';
import { VERIFIER_MONITOR, VerifierMonitor } from '../../vc/verifiers';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly moduleRef: ModuleRef
  ) {}

  async check() {
    const [database, redis, credentials] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkCredentials()
    ]);
    // `status` (the container healthcheck) follows the stores only: a broken trust-list source
    // must not make Docker restart the api. Monitoring watches `trustList` and `verifier`
    // (ADR-0014 §7).
    const isHealthy = database.status === 'up' && redis.status === 'up';

    return {
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        database,
        redis,
        ...(credentials ?? {})
      }
    };
  }

  /**
   * Only when the credential features are on: does the served trust list verify (and is it far
   * from expiry), and are the hosted verifiers still in it? Both are cached by their monitors.
   */
  private async checkCredentials(): Promise<{ trustList: { status: 'up' | 'down' }; verifier: { status: 'up' | 'down' } } | null> {
    let trustList: TrustListMonitor;
    let verifiers: VerifierMonitor;

    try {
      trustList = this.moduleRef.get<TrustListMonitor>(TRUST_LIST_MONITOR, { strict: false });
      verifiers = this.moduleRef.get<VerifierMonitor>(VERIFIER_MONITOR, { strict: false });
    } catch {
      return null;
    }

    const [t, v] = await Promise.all([trustList.check(), verifiers.check().catch(() => 'down' as const)]);

    return { trustList: { status: t }, verifier: { status: v } };
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
