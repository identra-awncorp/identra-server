import { Injectable } from '@nestjs/common';

import { createServiceStatus } from '../../common/types/service-status';

@Injectable()
export class SharingService {
  getStatus() {
    return createServiceStatus({
      module: 'sharing',
      status: 'scaffolded',
      purpose: 'Selective disclosure requests, QR sessions, consent, and share approvals.',
      next: ['Create share-request DTOs', 'Add QR session lifecycle', 'Record consent audit events']
    });
  }
}
