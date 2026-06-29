import { Injectable } from '@nestjs/common';

import { createServiceStatus } from '../../common/types/service-status';

@Injectable()
export class VerificationService {
  getStatus() {
    return createServiceStatus({
      module: 'verification',
      status: 'scaffolded',
      purpose: 'Credential verification, proof checks, and verification records.',
      next: ['Define proof verification boundary', 'Persist verification records', 'Add demo ZKP results']
    });
  }
}
