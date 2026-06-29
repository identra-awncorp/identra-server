import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { SharingService } from './sharing.service';

@ApiTags('sharing')
@Controller('sharing')
export class SharingController {
  constructor(private readonly sharingService: SharingService) {}

  @Get('status')
  getStatus() {
    return this.sharingService.getStatus();
  }
}
