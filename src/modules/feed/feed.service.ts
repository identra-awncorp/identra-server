import { Injectable } from '@nestjs/common';

import { createServiceStatus } from '../../common/types/service-status';

@Injectable()
export class FeedService {
  getStatus() {
    return createServiceStatus({
      module: 'feed',
      status: 'scaffolded',
      purpose: 'News feed posts, smart-contract posts, live/demo content, and reactions.',
      next: ['Add feed listing API', 'Model smart-contract payloads', 'Add content moderation boundary']
    });
  }
}
