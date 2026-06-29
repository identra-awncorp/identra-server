import { Injectable } from '@nestjs/common';

import { createServiceStatus } from '../../common/types/service-status';

@Injectable()
export class ChatService {
  getStatus() {
    return createServiceStatus({
      module: 'chat',
      status: 'scaffolded',
      purpose: 'Conversations, messages, delivery state, and action messages.',
      next: ['Add conversation list API', 'Add message send API', 'Add websocket events']
    });
  }
}
