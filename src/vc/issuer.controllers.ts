import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { HttpRequest, HttpResponse as SdkResponse } from '@identra/sdk-server';

import { allowAnyOrigin, apiError, HttpResponse, oauthError, ProtocolErrorFilter, V1ErrorFilter } from '../common/http-errors';
import { RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { createRedisStateStore, StateStore } from '../common/state-store';
import { DemoPortalGuard, PortalSession, PortalSessionData } from '../demo-portal/portal-sessions';
import { RedisService } from '../infrastructure/redis/redis.service';
import { ISSUER_STATE_NAMESPACE, ISSUERS, IssuerRegistry } from './issuers';

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Set by the body parsers when the app is created with `rawBody: true` (main.ts, tests). */
  rawBody?: Buffer;
  body?: unknown;
}

export type RawResponse = HttpResponse & { statusCode: number; getHeader(name: string): unknown; end(body: string): void };

/**
 * The exact request the SDK must see: lower-case header names and the body text byte for byte,
 * from the parser's raw buffer, never the parsed and re-serialised object.
 */
export function sdkRequest(req: RawRequest): HttpRequest {
  const headers: Record<string, string | undefined> = {};

  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }

  const parsed = req.body !== undefined && !(typeof req.body === 'object' && Object.keys(req.body as object).length === 0);

  if (!req.rawBody && parsed) throw new Error('raw request bodies are not captured (rawBody: true)');

  return { headers, body: req.rawBody?.toString('utf8') ?? '' };
}

/** Writes the SDK's response unchanged (res.end: Express would add a charset and an ETag). */
export function send(res: RawResponse, r: SdkResponse, options: { public?: boolean } = {}): void {
  res.statusCode = r.status;

  for (const [name, value] of Object.entries(r.headers)) res.setHeader(name, value);

  if (res.getHeader('Cache-Control') === undefined) res.setHeader('Cache-Control', 'no-store');
  if (options.public) allowAnyOrigin(res);

  res.end(r.body);
}

/**
 * OpenID4VCI 1.0 endpoints of docs/vc-api.md §4, unprefixed. Thin adapters: HTTP in, SDK call,
 * HTTP out. Anything thrown (a failing store or callback) becomes `500 { error: server_error }`.
 */
@ApiTags('issuance')
@Controller()
@UseFilters(ProtocolErrorFilter)
export class IssuerProtocolController {
  constructor(@Inject(ISSUERS) private readonly issuers: IssuerRegistry) {}

  private issuer(name: string) {
    const hosted = this.issuers.get(name);

    if (!hosted) throw oauthError(404, 'not_found', 'unknown credential issuer');

    return hosted.issuer;
  }

  @Get('.well-known/openid-credential-issuer/issuers/:name')
  metadata(@Param('name') name: string, @Res() res: RawResponse) {
    send(res, this.issuer(name).metadata(), { public: true });
  }

  @Get('.well-known/oauth-authorization-server/issuers/:name')
  authorizationServer(@Param('name') name: string, @Res() res: RawResponse) {
    send(res, this.issuer(name).authorizationServerMetadata(), { public: true });
  }

  @Get('issuers/:name/jwks')
  jwks(@Param('name') name: string, @Res() res: RawResponse) {
    send(res, this.issuer(name).jwks(), { public: true });
  }

  @Get('issuers/:name/offers/:offerId')
  async offer(@Param('name') name: string, @Param('offerId') offerId: string, @Res() res: RawResponse) {
    send(res, await this.issuer(name).offer(offerId), { public: true });
  }

  @Post('issuers/:name/token')
  @RateLimit('token')
  async token(@Param('name') name: string, @Req() req: RawRequest, @Res() res: RawResponse) {
    send(res, await this.issuer(name).token(sdkRequest(req)));
  }

  @Post('issuers/:name/nonce')
  @RateLimit('write')
  async nonce(@Param('name') name: string, @Res() res: RawResponse) {
    send(res, await this.issuer(name).nonce());
  }

  @Post('issuers/:name/credential')
  @RateLimit('write')
  async credential(@Param('name') name: string, @Req() req: RawRequest, @Res() res: RawResponse) {
    send(res, await this.issuer(name).credential(sdkRequest(req)));
  }
}

const PORTAL_OFFER_SECONDS = 1800;
const CONFIGURATION = 'bang-tot-nghiep-v1';

/**
 * School portal, second half (docs/vc-api.md §5). At most one pending offer per student: a new
 * offer supersedes the previous one, whose code stops working and whose state reads `expired`.
 */
@ApiTags('demo-school')
@Controller('demo/school/offers')
@UseFilters(V1ErrorFilter)
@UseGuards(DemoPortalGuard)
@RateLimitFailClosed()
@ApiBearerAuth()
export class PortalOffersController {
  private readonly portalState: StateStore;
  private readonly issuerState: StateStore;

  constructor(
    @Inject(ISSUERS) private readonly issuers: IssuerRegistry,
    redis: RedisService
  ) {
    this.portalState = createRedisStateStore(redis.getClient(), 'portal-offer');
    this.issuerState = createRedisStateStore(redis.getClient(), ISSUER_STATE_NAMESPACE);
  }

  private hosted(session: PortalSessionData) {
    const hosted = this.issuers.get(session.issuerName);

    if (!hosted) throw apiError(503, 'UNAVAILABLE', 'This school does not issue credentials here.');

    return hosted;
  }

  @Post()
  @HttpCode(201)
  @RateLimit('write')
  async create(@PortalSession() session: PortalSessionData) {
    if (session.role !== 'student') throw apiError(403, 'FORBIDDEN', 'Only students can collect a diploma.');

    const { issuer, issuerUri } = this.hosted(session);
    // The PIN (txCode) exists only in this response: the SDK keeps a keyed hash of it.
    const offer = await issuer.createOffer({ subjectRef: session.username, configurationId: CONFIGURATION });
    const previous = await this.portalState.swap(
      `current:${session.issuerName}:${session.username}`,
      offer.offerId,
      PORTAL_OFFER_SECONDS
    );

    if (previous && previous !== offer.offerId && (await issuer.offerStatus(previous))?.status === 'pending') {
      await this.portalState.put(`superseded:${previous}`, '1', PORTAL_OFFER_SECONDS);
      // The SDK has no cancel operation: removing its documented `offer:<id>` record makes the
      // offer 404 and its pre-authorized code `invalid_grant` (docs/architecture.md §8).
      await this.issuerState.take(`vci:${issuerUri}:offer:${previous}`);
    }

    return { ...offer, serverTime: new Date().toISOString() };
  }

  @Get(':offerId')
  async status(@PortalSession() session: PortalSessionData, @Param('offerId') offerId: string) {
    const state = await this.hosted(session).issuer.offerStatus(offerId);

    // Unknown, too old, or someone else's: the same answer.
    if (!state || state.subjectRef !== session.username) throw apiError(404, 'NOT_FOUND', 'No such offer.');

    const superseded = state.status === 'pending' && (await this.portalState.get(`superseded:${offerId}`)) !== null;

    return { status: superseded ? 'expired' : state.status, serverTime: new Date().toISOString() };
  }
}
