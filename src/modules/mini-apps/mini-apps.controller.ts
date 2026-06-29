import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { MiniAppsService } from './mini-apps.service';

@ApiTags('mini-apps')
@Controller('mini-apps')
export class MiniAppsController {
  constructor(private readonly miniAppsService: MiniAppsService) {}

  @Get()
  listMiniApps() {
    return this.miniAppsService.listMiniApps();
  }
}
