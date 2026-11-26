import {
  Controller,
  Delete,
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
import type { Clock } from '@identra/sdk-core';
import { ACCESS_TOKEN_SECONDS, OFFER_STATUS_SECONDS, type HttpRequest, type HttpResponse as SdkResponse } from '@identra/sdk-server';

import { allowAnyOrigin, apiError, HttpResponse, oauthError, ProtocolErrorFilter, V1ErrorFilter } from '../common/http-errors';
import { RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { clientOf, Reservation } from '../common/live-cap';
import { createRedisStateStore, StateStore } from '../common/state-store';
import { DemoPortalGuard, PortalSession, PortalSessionData } from '../demo-portal/portal-sessions';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { isOpenId4Vci } from './hosted-issuers';
import { HostedIssuer, ISSUERS, IssuerRegistry, offerOwnerKey, PORTAL_OFFER_NAMESPACE } from './issuers';
import { VcCredentialsService } from './vc-credentials.service';
import { ISSUER_CLOCK, PKI, Pki } from './vc.providers';

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  /** The client address (trust proxy: the last X-Forwarded-For hop, set by nginx). */
  ip?: string;
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
 * HTTP out. Postgres or Redis down becomes `503 temporarily_unavailable`; anything else thrown
 * (a failing callback) becomes `500 { error: server_error }`.
 */
@ApiTags('issuance')
@Controller()
@UseFilters(ProtocolErrorFilter)
export class IssuerProtocolController {
  constructor(
    @Inject(ISSUERS) private readonly issuers: IssuerRegistry,
    @Inject(PKI) private readonly pki: Pki
  ) {}

  private hosted(name: string): HostedIssuer {
    const hosted = this.issuers.get(name);

    if (hosted) return hosted;
    // Hosted here but not able to sign at the moment (vc.providers.ts, issuers.ts).
    if (this.pki.issuers.some((i) => isOpenId4Vci(i) && i.name === name)) throw oauthError(503, 'temporarily_unavailable', 'the credential issuer is unavailable');

    // Unknown, the product issuers (no OpenID4VCI endpoints), a DID issuer with DPKI off.
    throw oauthError(404, 'not_found', 'unknown credential issuer');
  }

  private issuer(name: string) {
    return this.hosted(name).issuer;
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

  /**
   * Unauthenticated, as OpenID4VCI 1.0 §7 defines it. Anonymous state (a c_nonce, 5 minutes until
   * used): each client has a share of the global cap (§8), so one client cannot use up the others'.
   */
  @Post('issuers/:name/nonce')
  @RateLimit('write')
  async nonce(@Param('name') name: string, @Req() req: RawRequest, @Res() res: RawResponse) {
    const hosted = this.hosted(name);
    const answer = await hosted.issuer.nonce();
    const slot = await hosted.reserveNonce((JSON.parse(answer.body) as { c_nonce: string }).c_nonce, clientOf(req.ip));

    if (!slot.ok) {
      res.setHeader('Retry-After', String(slot.retryAfterSeconds));
      throw slot.scope === 'client'
        ? oauthError(429, 'temporarily_unavailable', 'this client holds too many unused nonces; use one or wait')
        : oauthError(503, 'temporarily_unavailable', 'too many nonces are outstanding; try again shortly');
    }

    send(res, answer);
  }

  @Post('issuers/:name/credential')
  @RateLimit('write')
  async credential(@Param('name') name: string, @Req() req: RawRequest, @Res() res: RawResponse) {
    send(res, await this.issuer(name).credential(sdkRequest(req)));
  }
}

const CONFIGURATION = 'bang-tot-nghiep-v1';
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{22}$/;

/** 429 when this client used its share, 503 when everybody's cap is full (docs/vc-api.md §8). */
function refusal(slot: Exclude<Reservation, { ok: true }>, what: string) {
  return slot.scope === 'client'
    ? apiError(429, 'RATE_LIMITED', `This client has too many ${what} open; finish or cancel one, or wait.`, { retryAfter: slot.retryAfterSeconds })
    : apiError(503, 'UNAVAILABLE', `Too many ${what} are open; try again shortly.`, { retryAfter: slot.retryAfterSeconds });
}

interface PortalRequest {
  ip?: string;
}

/**
 * School portal, second half (docs/vc-api.md §5): a student's offers and the credentials issued
 * from them. Everything belongs to the portal SESSION that created it (the accounts are shared by
 * every visitor): another session, even of the same account, does not see or touch it.
 */
@ApiTags('demo-school')
@Controller('demo/school')
@UseFilters(V1ErrorFilter)
@UseGuards(DemoPortalGuard)
@RateLimitFailClosed()
@ApiBearerAuth()
export class PortalOffersController {
  private readonly portalState: StateStore;

  constructor(
    @Inject(ISSUERS) private readonly issuers: IssuerRegistry,
    @Inject(ISSUER_CLOCK) private readonly clock: Clock,
    private readonly prisma: PrismaService,
    private readonly credentials: VcCredentialsService,
    redis: RedisService
  ) {
    this.portalState = createRedisStateStore(redis.getClient(), PORTAL_OFFER_NAMESPACE);
  }

  private hosted(session: PortalSessionData) {
    const hosted = this.issuers.get(session.issuerName);

    if (!hosted) throw apiError(503, 'UNAVAILABLE', 'This school does not issue credentials here.');

    return hosted;
  }

  private student(session: PortalSessionData, action: string) {
    if (session.role !== 'student') throw apiError(403, 'FORBIDDEN', `Only students can ${action}.`);
  }

  @Post('offers')
  @HttpCode(201)
  @RateLimit('write')
  async create(@PortalSession() session: PortalSessionData, @Req() req: PortalRequest) {
    this.student(session, 'collect a diploma');

    const hosted = this.hosted(session);
    // The PIN (txCode) exists only in this response: the SDK keeps a keyed hash of it.
    const offer = await hosted.issuer.createOffer({ subjectRef: session.username, configurationId: CONFIGURATION });
    // Counted once created (its id is the member); refused, it is removed again at once.
    const slot = await hosted.reserveOffer(offer.offerId, clientOf(req.ip));

    if (!slot.ok) throw refusal(slot, 'offers');

    await this.portalState.put(offerOwnerKey(offer.offerId), session.sessionHash, OFFER_STATUS_SECONDS);

    return { ...offer, serverTime: new Date().toISOString() };
  }

  /** The offer if this session created it (unknown, too old or someone else's: the same 404). */
  private async owned(session: PortalSessionData, offerId: string) {
    const hosted = this.hosted(session);
    const [state, owner] = await Promise.all([hosted.issuer.offerStatus(offerId), this.portalState.get(offerOwnerKey(offerId))]);

    if (!state || state.subjectRef !== session.username || owner !== session.sessionHash) throw apiError(404, 'NOT_FOUND', 'No such offer.');

    return { hosted, state };
  }

  @Get('offers/:offerId')
  async status(@PortalSession() session: PortalSessionData, @Param('offerId') offerId: string) {
    const { hosted, state } = await this.owned(session, offerId);

    return { status: state.status === 'pending' ? await this.pendingOrRedeemed(hosted, offerId) : state.status, serverTime: new Date().toISOString() };
  }

  /** Cancels a pending offer (its code stops working, its place is freed); an issued one stays issued. */
  @Delete('offers/:offerId')
  @RateLimit('write')
  async cancel(@PortalSession() session: PortalSessionData, @Param('offerId') offerId: string) {
    const { hosted } = await this.owned(session, offerId);

    // Safe on a used or expired offer.
    await hosted.issuer.cancelOffer(offerId);

    const after = await hosted.issuer.offerStatus(offerId);

    return { offerId, status: after?.status === 'issued' ? 'issued' : 'expired', serverTime: new Date().toISOString() };
  }

  /**
   * A student revokes a credential issued in THIS session ("I lost my phone"): revocation only,
   * final. Anything else, also another session's credential of the same account, is 404.
   */
  @Post('credentials/:credentialId/revoke')
  @HttpCode(200)
  @RateLimit('write')
  async revoke(@PortalSession() session: PortalSessionData, @Param('credentialId') id: string) {
    this.student(session, 'revoke their own copy; the registrar uses the status route');

    const row = CREDENTIAL_ID.test(id)
      ? await this.prisma.vcIssuedCredential.findFirst({
          where: { id, issuerName: session.issuerName, subjectRef: session.username, portalSessionHash: session.sessionHash }
        })
      : null;

    if (!row) throw apiError(404, 'NOT_FOUND', 'No such credential in this session.');
    if (row.status === 'revoked') throw apiError(409, 'CONFLICT', 'The credential is already revoked.');

    return this.credentials.changeStatus(session.issuerName, id, 'revoked');
  }
  /**
   * L5: the SDK reads `pending` until the offer's 10 minutes pass, also after the token endpoint
   * consumed the code (the offer record is gone: offer() answers 404) when the credential was then
   * never issued. The first time the portal sees the code consumed is kept; once an access token
   * from then would have expired (300 s) without an issuance, the offer reads `expired`.
   */
  private async pendingOrRedeemed(hosted: HostedIssuer, offerId: string): Promise<'pending' | 'expired'> {
    if ((await hosted.issuer.offer(offerId)).status !== 404) return 'pending';

    const key = `redeemed:${offerId}`;
    const now = this.clock.now().getTime();
    // Two polls racing here record nearly the same time; either is fine.
    const seen = Number((await this.portalState.get(key)) ?? now);

    if (seen === now) await this.portalState.put(key, String(now), OFFER_STATUS_SECONDS);

    return now - seen >= ACCESS_TOKEN_SECONDS * 1000 ? 'expired' : 'pending';
  }
}
