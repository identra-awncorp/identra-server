import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { TRUST_LIST_MONITOR, TrustListMonitor } from '../../vc/trust-list';
import { STATUS_MONITOR, StatusMonitor } from '../../vc/vc.providers';
import { VERIFIER_MONITOR, VerifierMonitor } from '../../vc/verifiers';

/** Redis is `degraded` above this share of `maxmemory` (ADR-0016: 128 MB, `noeviction`). */
export const REDIS_MEMORY_WARN_SHARE = 0.8;

const field = (info: string, name: string) => Number(new RegExp(`^${name}:(\\d+)`, 'm').exec(info)?.[1] ?? NaN);

@Injectable()
export class HealthService {
  /** How long a memory verdict is kept: INFO and a probe write at most this often. Tests set 0. */
  static memoryProbeEveryMs = 10_000;
  private memory?: { at: number; state: 'up' | 'degraded' };

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
  private async checkCredentials() {
    let trustList: TrustListMonitor;
    let verifiers: VerifierMonitor;
    let statusLists: StatusMonitor;

    try {
      trustList = this.moduleRef.get<TrustListMonitor>(TRUST_LIST_MONITOR, { strict: false });
      verifiers = this.moduleRef.get<VerifierMonitor>(VERIFIER_MONITOR, { strict: false });
      statusLists = this.moduleRef.get<StatusMonitor>(STATUS_MONITOR, { strict: false });
    } catch {
      return null;
    }

    const down = () => 'down' as const;
    const [t, s, v] = await Promise.all([trustList.check(), statusLists.check().catch(down), verifiers.check().catch(down)]);

    return { trustList: { status: t }, statusLists: { status: s }, verifier: { status: v } };
  }

  /**
   * `degraded` when used memory is above 80 % of maxmemory, or a write is refused (OOM under
   * `noeviction`): reads and pings still work, so a ping alone would say `up` while every
   * sign-in, offer and session fails. Cached for memoryProbeEveryMs.
   */
  private async checkRedisMemory(): Promise<'up' | 'degraded'> {
    const now = Date.now();

    if (this.memory && now - this.memory.at < HealthService.memoryProbeEveryMs) return this.memory.state;

    const client = this.redis.getClient();
    const info = await client.info('memory');
    const used = field(info, 'used_memory');
    const max = field(info, 'maxmemory');
    const writable = await client.set('health:probe', '1', 'PX', 10_000).then(
      () => true,
      () => false
    );
    const state = !writable || (max > 0 && used > max * REDIS_MEMORY_WARN_SHARE) ? 'degraded' : 'up';

    this.memory = { at: now, state };

    return state;
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

      if (response !== 'PONG') return { status: 'degraded' as const };

      return { status: await this.checkRedisMemory() };
    } catch {
      // Public endpoint: never echo driver errors (they name hosts and ports).
      return { status: 'down' as const };
    }
  }
}
