import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('status')
  getStatus() {
    return this.paymentsService.getStatus();
  }
}
