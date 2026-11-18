import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // The OpenID4VCI controllers hand the SDK the request body exactly as received.
    rawBody: true
  });
  const config = app.get(ConfigService);

  app.enableShutdownHooks();
  configureApp(app);

  await app.listen(config.get<number>('PORT', 4000), config.get<string>('HOST', '0.0.0.0'));
}

void bootstrap();
