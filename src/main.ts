import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'reflect-metadata';

import { AppModule } from './app.module';
import { parseCorsOrigins } from './config/cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true
  });

  const config = app.get(ConfigService);
  const apiPrefix = config.get<string>('API_PREFIX', 'v1');
  const appName = config.get<string>('APP_NAME', 'Identra Server');
  const port = config.get<number>('PORT', 4000);
  const host = config.get<string>('HOST', '0.0.0.0');

  app.enableShutdownHooks();
  app.setGlobalPrefix(apiPrefix);
  app.enableCors({
    origin: parseCorsOrigins(config.get<string>('CORS_ORIGINS')),
    credentials: true
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true
    })
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle(appName)
    .setDescription('Identra API for mobile app, website demos, and super-app modules.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(port, host);
}

void bootstrap();
