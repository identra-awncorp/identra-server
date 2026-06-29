import { Injectable } from '@nestjs/common';

import { createServiceStatus } from '../../common/types/service-status';

@Injectable()
export class NotificationsService {
  getStatus() {
    return createServiceStatus({
      module: 'notifications',
      status: 'scaffolded',
      purpose: 'In-app, push, email, and websocket notification delivery.',
      next: ['Add notification listing API', 'Add push provider adapter', 'Add read-state endpoints']
    });
  }
}
