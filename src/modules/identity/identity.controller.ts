import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IdentityService } from './identity.service';

@ApiTags('identity')
@Controller('identity')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Get('status')
  getStatus() {
    return this.identityService.getStatus();
  }
}
