import { Injectable } from '@nestjs/common';

import { createServiceStatus } from '../../common/types/service-status';

@Injectable()
export class IdentityService {
  getStatus() {
    return createServiceStatus({
      module: 'identity',
      status: 'scaffolded',
      purpose: 'DID profiles, issuer registry, verifier registry, and trust metadata.',
      next: ['Add DID document model', 'Expose issuer registry APIs', 'Add verifier trust policy']
    });
  }
}
