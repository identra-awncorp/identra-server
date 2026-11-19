import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

const logger = new Logger('Redis');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          lazyConnect: true,
          // Fail fast while Redis is down or reconnecting: every command (queued ones included)
          // gives up after 1 s, and a request answers 503 instead of hanging (docs/vc-api.md §2).
          commandTimeout: 1000,
          connectTimeout: 2000,
          maxRetriesPerRequest: 1
        }).on('error', (error: Error) => logger.warn(`Redis unavailable: ${error.message}`))
    },
    RedisService
  ],
  exports: [RedisService]
})
export class RedisModule {}
