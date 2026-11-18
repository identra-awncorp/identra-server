import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { parseCorsOrigins } from './config/cors';

/**
 * The protocol routes served WITHOUT the global `/v1` prefix, exactly as listed in
 * docs/vc-api.md §3, §4 and §6 (paths fixed by OpenID4VCI/VP or signed into credentials).
 * Matched against the path and method a controller declares; anything not listed here, e.g.
 * `POST /v1/issuers/:name/credentials/:credentialId/status`, stays under `/v1`.
 */
export const UNPREFIXED_ROUTES = [
  { method: RequestMethod.GET, path: 'trust-list' },
  { method: RequestMethod.GET, path: 'issuers/:name/status/:n' },
  { method: RequestMethod.GET, path: 'issuers/:name/jwks' },
  { method: RequestMethod.GET, path: 'issuers/:name/offers/:offerId' },
  { method: RequestMethod.POST, path: 'issuers/:name/token' },
  { method: RequestMethod.POST, path: 'issuers/:name/nonce' },
  { method: RequestMethod.POST, path: 'issuers/:name/credential' },
  { method: RequestMethod.GET, path: '.well-known/openid-credential-issuer/issuers/:name' },
  { method: RequestMethod.GET, path: '.well-known/oauth-authorization-server/issuers/:name' },
  { method: RequestMethod.GET, path: 'oid4vp/request/:requestId' },
  { method: RequestMethod.POST, path: 'oid4vp/response/:requestId' }
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
  // req.ip is the LAST X-Forwarded-For entry. nginx overwrites that header with the client
  // address it took from CF-Connecting-IP (deploy/nginx/api-identra.conf.example), so a
  // client cannot choose its own IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Registered before init, so Nest skips its default (100kb) json/urlencoded parsers.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: false });
  app.useBodyParser('text', { limit: BODY_LIMIT, type: 'application/jwt' });

  app.setGlobalPrefix(config.get<string>('API_PREFIX', 'v1'), {
    exclude: UNPREFIXED_ROUTES
  });
  app.enableCors({
    origin: parseCorsOrigins(config.get<string>('CORS_ORIGINS')),
    credentials: true,
    // Lets the website read how long to wait after a 429 (docs/vc-api.md §2).
    exposedHeaders: ['Retry-After']
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

  // API documentation (/docs, /docs-json) is for developers, not for the public deployment.
  if (config.get<string>('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(config.get<string>('APP_NAME', 'Identra Server'))
      .setDescription('Identra API for mobile app, website demos, and super-app modules.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();

    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }
}
