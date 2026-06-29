import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { VerificationService } from './verification.service';

@ApiTags('verification')
@Controller('verification')
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Get('status')
  getStatus() {
    return this.verificationService.getStatus();
  }
}
