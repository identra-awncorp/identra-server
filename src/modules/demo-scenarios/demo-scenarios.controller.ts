import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DemoScenariosService } from './demo-scenarios.service';

@ApiTags('demo-scenarios')
@Controller('demo-scenarios')
export class DemoScenariosController {
  constructor(private readonly demoScenariosService: DemoScenariosService) {}

  @Get()
  listScenarios() {
    return this.demoScenariosService.listScenarios();
  }

  @Post(':slug/start')
  startScenario(@Param('slug') slug: string) {
    return this.demoScenariosService.startScenario(slug);
  }
}
