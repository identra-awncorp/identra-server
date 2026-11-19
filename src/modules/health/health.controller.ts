import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** 200 for `ok` and `degraded`, 503 for `down` (the compose healthcheck reads the status code). */
  @Get()
  async check(@Res({ passthrough: true }) res: { status(code: number): unknown }) {
    const health = await this.healthService.check();

    if (health.status === 'down') res.status(503);

    return health;
  }
}
