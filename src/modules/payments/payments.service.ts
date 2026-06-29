import { Injectable } from '@nestjs/common';

import { createServiceStatus } from '../../common/types/service-status';

@Injectable()
export class PaymentsService {
  getStatus() {
    return createServiceStatus({
      module: 'payments',
      status: 'scaffolded',
      purpose: 'IDPay drafts, transaction state, QR payments, and provider adapters.',
      next: ['Add payment draft validation', 'Add transaction state machine', 'Add provider adapter interface']
    });
  }
}
