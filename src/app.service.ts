import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BUILD } from './build-info';

@Injectable()
export class AppService {
  constructor(private readonly config: ConfigService) {}

  getInfo() {
    return {
      name: this.config.get<string>('APP_NAME', 'Identra Server'),
      version: '0.1.0',
      mode: 'modular-monolith',
      build: BUILD,
      // Swagger is only served outside production (configureApp).
      ...(this.config.get<string>('NODE_ENV') === 'production' ? {} : { docs: '/docs' })
    };
  }
}
