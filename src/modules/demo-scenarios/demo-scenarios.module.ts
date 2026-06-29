import { Module } from '@nestjs/common';

import { DemoScenariosController } from './demo-scenarios.controller';
import { DemoScenariosService } from './demo-scenarios.service';

@Module({
  controllers: [DemoScenariosController],
  providers: [DemoScenariosService]
})
export class DemoScenariosModule {}
