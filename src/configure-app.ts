import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { parseCorsOrigins } from './config/cors';

/**
 * Routes served WITHOUT the global `/v1` prefix (path-to-regexp v8 syntax, matched against
 * the route path a controller declares). Reserved for the protocol endpoints whose URLs are
 * fixed by the specs and ADR-0010/0011/0013/0015:
 *   /.well-known/openid-credential-issuer/issuers/:name
 *   /.well-known/oauth-authorization-server/issuers/:name
 *   /issuers/:name/**   (credential issuer: token, credential, nonce, ...)
 *   /trust-list
 * Caution: EVERY controller route starting with `issuers` loses the prefix, so the ADR-0013
 * admin endpoint `POST /v1/issuers/:id/credentials/:credId/status` must not be declared under
 * `issuers/...` or it ends up at `/issuers/...`.
 */
export const UNPREFIXED_ROUTE_PATHS = [
  '.well-known/openid-credential-issuer{/*path}',
  '.well-known/oauth-authorization-server{/*path}',
  'issuers{/*path}',
  'trust-list'
];

// Request bodies are small (OAuth forms, JWTs, JSON); anything bigger is refused with 413.
const BODY_LIMIT = '64kb';

/**
 * Everything main.ts sets up on the app before listening. Tests call this too, so they run
 * against the same prefix, parsers, pipes and CORS as production.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);

  // Exactly one reverse proxy (nginx on localhost, ADR-0016) sits in front of the app, so
  // req.ip is the address nginx puts last in X-Forwarded-For. nginx must therefore set that
  // header to the real client (e.g. from CF-Connecting-IP via the realip module).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Registered before init, so Nest skips its default (100kb) json/urlencoded parsers.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: false });
  app.useBodyParser('text', { limit: BODY_LIMIT, type: 'application/jwt' });

  app.setGlobalPrefix(config.get<string>('API_PREFIX', 'v1'), {
    exclude: UNPREFIXED_ROUTE_PATHS.map((path) => ({ path, method: RequestMethod.ALL }))
  });
  app.enableCors({
    origin: parseCorsOrigins(config.get<string>('CORS_ORIGINS')),
    credentials: true
  });

  // Strict DTO validation for /v1. It only applies to parameters typed as a class: a protocol
  // controller that must accept extra fields types its body as a plain object
  // (`Record<string, unknown>`), which this pipe skips, and validates with its own pipe, e.g.
  // `@Body(new ValidationPipe({ expectedType: TokenRequestDto, whitelist: true }))`.
  // A controller-level @UsePipes alone cannot relax this pipe: global pipes run first.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true
    })
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle(config.get<string>('APP_NAME', 'Identra Server'))
    .setDescription('Identra API for mobile app, website demos, and super-app modules.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();

  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
}
