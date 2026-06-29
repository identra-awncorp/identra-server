import { Injectable } from '@nestjs/common';

import { createServiceStatus } from '../../common/types/service-status';

@Injectable()
export class AuthService {
  getStatus() {
    return createServiceStatus({
      module: 'auth',
      status: 'scaffolded',
      purpose: 'Phone/OTP login, refresh tokens, and device sessions.',
      next: ['Add OTP provider abstraction', 'Hash refresh tokens', 'Add guards and decorators']
    });
  }
}
