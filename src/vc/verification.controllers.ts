import { randomBytes } from 'node:crypto';

import { Body, Controller, Get, HttpCode, Inject, Logger, Param, Post, Req, Res, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { SESSION_KEEP_SECONDS, SESSION_SECONDS } from '@identra/sdk-server';
import type { Clock } from '@identra/sdk-core';

import { apiError, oauthError, ProtocolErrorFilter, unavailable, V1ErrorFilter } from '../common/http-errors';
import { clientOf, createLiveCaps, LiveCaps } from '../common/live-cap';
import { createRedisStateStore, StateStore } from '../common/state-store';
import { RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { RedisService } from '../infrastructure/redis/redis.service';
import { RawRequest, RawResponse, sdkRequest, send } from './issuer.controllers';
import { HOSTED_VERIFIERS } from './hosted-issuers';
import { HostedVerifiers, VERIFIER_CLOCK, VERIFIERS } from './verifiers';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const logger = new Logger('Verification');
const KIND = 'vp-sessions';
/** Sessions created in the last 30 minutes (their record and result stay readable that long). */
const RECORDS_KIND = 'vp-session-records';
/** Live sessions of one client (an IPv4 address or IPv6 /56; its /48: NETWORK_SHARES ×) inside the global cap (docs/vc-api.md §8). */
export const SESSIONS_PER_CLIENT = 10;
/** Sessions created in 30 minutes: per client, and globally per live session (the bound before places were freed early). */
export const SESSION_RECORDS_PER_CLIENT = 100;
export const SESSION_RECORDS_PER_LIVE_SESSION = SESSION_KEEP_SECONDS / SESSION_SECONDS;

/** Session id → the id of its live place (5 minutes), so that a final response frees the place. */
const placesOf = (redis: RedisService) => createRedisStateStore(redis.getClient(), 'vp-place');

const known = (verifier: string, scenario: string) =>
  HOSTED_VERIFIERS.some((v) => v.name === verifier && Object.hasOwn(v.scenarios, scenario));

class CreateSessionDto {
  @IsString()
  @Matches(NAME)
  verifier: string;

  @IsString()
  @Matches(NAME)
  scenario: string;
}

/**
 * Verification sessions for the website (docs/vc-api.md §6). Anonymous, so their Redis cost is
 * bounded (§8) by a global cap on live sessions (VERIFICATION_MAX_LIVE_SESSIONS, each holding its
 * ~7 KB request object until it is final or 5 minutes pass) and one on sessions created in 30
 * minutes (their records: 6 × the live cap), each with a share per client inside it, reserved
 * only for a valid request (body, verifier and scenario checked first). A live place is freed by
 * the response that makes the session final (the SDK has then stored the result and deleted the
 * request object); the 30-minute place is never freed early, so freeing live places cannot buy
 * more records. Responses are `Cache-Control: no-store` (configureApp): the id reads the result.
 */
@ApiTags('verification')
@Controller('verification/sessions')
@UseFilters(V1ErrorFilter)
// Sessions live in Redis: without it there is nothing to create or read (503).
@RateLimitFailClosed()
export class VerificationSessionsController {
  private readonly caps: LiveCaps;
  private readonly places: StateStore;
  private readonly cap: number;

  constructor(
    @Inject(VERIFIERS) private readonly verifiers: HostedVerifiers,
    @Inject(VERIFIER_CLOCK) clock: Clock,
    config: ConfigService,
    redis: RedisService
  ) {
    this.caps = createLiveCaps(redis.getClient(), clock);
    this.places = placesOf(redis);
    this.cap = config.getOrThrow<number>('VERIFICATION_MAX_LIVE_SESSIONS');
  }

  @Post()
  @HttpCode(201)
  @RateLimit('sessionCreation')
  async create(@Body() body: CreateSessionDto, @Req() req: { ip?: string }) {
    if (!known(body.verifier, body.scenario)) throw apiError(404, 'NOT_FOUND', 'No such verifier or scenario.');

    const verifier = await this.verifiers.available(body.verifier);

    if (!verifier) throw unavailable('This verifier cannot create sessions at the moment.');

    const id = randomBytes(16).toString('base64url');
    const client = clientOf(req.ip);
    const records = await this.caps.reserve(RECORDS_KIND, id, SESSION_KEEP_SECONDS, {
      cap: this.cap * SESSION_RECORDS_PER_LIVE_SESSION,
      perClient: { ...client, cap: SESSION_RECORDS_PER_CLIENT }
    });
    const slot = records.ok ? await this.caps.reserve(KIND, id, SESSION_SECONDS, { cap: this.cap, perClient: { ...client, cap: SESSIONS_PER_CLIENT } }) : records;
    const giveBack = () => Promise.all([this.caps.release(KIND, id), this.caps.release(RECORDS_KIND, id)]);

    if (!slot.ok) {
      if (records.ok) await this.caps.release(RECORDS_KIND, id);

      throw slot.scope === 'client'
        ? apiError(429, 'RATE_LIMITED', 'This client has too many verification sessions open; wait for one to end.', { retryAfter: slot.retryAfterSeconds })
        : apiError(503, 'UNAVAILABLE', 'Too many verification sessions are open; try again shortly.', { retryAfter: slot.retryAfterSeconds });
    }

    const created = await verifier.createSession({ scenario: body.scenario }).catch(async (error: unknown) => {
      await giveBack().catch(() => undefined);
      throw error;
    });

    if (!created.ok) {
      await giveBack();

      if (created.reason === 'unknown_scenario') throw apiError(404, 'NOT_FOUND', 'No such verifier or scenario.');

      this.verifiers.notListed(body.verifier);
      throw unavailable('This verifier is not in the trust list at the moment.');
    }

    const { session } = created;

    // Best effort: without it the place is freed after its 5 minutes.
    await this.places.put(session.id, id, SESSION_SECONDS).catch(() => undefined);

    // requestId is never handed out on its own: it is inside the QR, which only a wallet reads.
    return { id: session.id, qr: session.qr, expiresAt: session.expiresAt, serverTime: session.serverTime };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    for (const verifier of this.verifiers.built()) {
      const session = await verifier.session(id);

      if (session) return session;
    }

    throw apiError(404, 'NOT_FOUND', 'No such verification session.');
  }
}

/**
 * OpenID4VP endpoints for wallets (docs/vc-api.md §6), unprefixed thin adapters. The result is
 * kept by the SDK in Redis only (30 minutes); the log line carries the session id prefix, the
 * outcome and the first failing check code, nothing else.
 */
@ApiTags('verification')
@Controller('oid4vp')
@UseFilters(ProtocolErrorFilter)
export class Oid4vpController {
  private readonly caps: LiveCaps;
  private readonly places: StateStore;

  constructor(
    @Inject(VERIFIERS) private readonly verifiers: HostedVerifiers,
    @Inject(VERIFIER_CLOCK) clock: Clock,
    redis: RedisService
  ) {
    this.caps = createLiveCaps(redis.getClient(), clock);
    this.places = placesOf(redis);
  }

  @Get('request/:requestId')
  async request(@Param('requestId') requestId: string, @Res() res: RawResponse) {
    // Each verifier answers null for request ids it does not hold.
    for (const verifier of this.verifiers.built()) {
      const answer = await verifier.requestObject(requestId);

      if (answer) return send(res, answer);
    }

    throw oauthError(404, 'not_found', 'unknown or finished request');
  }

  @Post('response/:requestId')
  @RateLimit('write')
  async response(@Param('requestId') requestId: string, @Req() req: RawRequest, @Res() res: RawResponse) {
    const request = sdkRequest(req);

    for (const verifier of this.verifiers.built()) {
      const handled = await verifier.handleResponse(requestId, request);

      if (!handled) continue;

      const { outcome } = handled;
      // Ids and codes only, the session id as an 8-character prefix (it reads the result).
      const what = outcome.final ? (outcome.ok ? 'verified' : 'failed') : 'refused';

      logger.log(`Presentation ${outcome.sessionId.slice(0, 8)}: ${what}${outcome.code ? ` (${outcome.code})` : ''}`);

      // Final: the result is stored and the request object deleted, so its live place is free
      // (taken once: of concurrent responses only one is final). Best effort, as above.
      if (outcome.final) {
        const place = await this.places.take(outcome.sessionId).catch(() => null);

        if (place) await this.caps.release(KIND, place).catch(() => undefined);
      }

      return send(res, handled.response);
    }

    throw oauthError(400, 'invalid_request', 'the response is not acceptable');
  }
}
