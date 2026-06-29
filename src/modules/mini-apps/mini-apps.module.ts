import { Module } from '@nestjs/common';

import { MiniAppsController } from './mini-apps.controller';
import { MiniAppsService } from './mini-apps.service';

@Module({
  controllers: [MiniAppsController],
  providers: [MiniAppsService]
})
export class MiniAppsModule {}
