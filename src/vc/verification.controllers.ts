import { Body, Controller, Get, HttpCode, Inject, Logger, Param, Post, Req, Res, UseFilters } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { SESSION_SECONDS } from '@identra/sdk-server';
import type { Clock } from '@identra/sdk-core';

import { apiError, oauthError, ProtocolErrorFilter, unavailable, V1ErrorFilter } from '../common/http-errors';
import { createLiveCap, LiveCap } from '../common/live-cap';
import { GlobalRateLimit, RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { RedisService } from '../infrastructure/redis/redis.service';
import { RawRequest, RawResponse, sdkRequest, send } from './issuer.controllers';
import { HOSTED_VERIFIERS } from './hosted-issuers';
import { HostedVerifiers, VERIFIER_CLOCK, VERIFIERS } from './verifiers';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HOSTED_NAMES = new Set(HOSTED_VERIFIERS.map((v) => v.name));
const logger = new Logger('Verification');

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
 * bounded three ways (§8): per client, per minute across all clients, and by a global cap on live
 * sessions (VERIFICATION_MAX_LIVE_SESSIONS, each holding its ~6 KB request object for 5 minutes).
 * Responses are `Cache-Control: no-store` (configureApp): the id reads the result.
 */
@ApiTags('verification')
@Controller('verification/sessions')
@UseFilters(V1ErrorFilter)
// Sessions live in Redis: without it there is nothing to create or read (503).
@RateLimitFailClosed()
export class VerificationSessionsController {
  private readonly live: LiveCap;

  constructor(
    @Inject(VERIFIERS) private readonly verifiers: HostedVerifiers,
    @Inject(VERIFIER_CLOCK) clock: Clock,
    config: ConfigService,
    redis: RedisService
  ) {
    this.live = createLiveCap(redis.getClient(), 'vp-sessions', {
      max: config.getOrThrow<number>('VERIFICATION_MAX_LIVE_SESSIONS'),
      lifetimeSeconds: SESSION_SECONDS,
      clock
    });
  }

  @Post()
  @HttpCode(201)
  @RateLimit('sessionCreation')
  @GlobalRateLimit()
  async create(@Body() body: CreateSessionDto) {
    if (!HOSTED_NAMES.has(body.verifier)) throw apiError(404, 'NOT_FOUND', 'No such verifier or scenario.');

    const verifier = await this.verifiers.available(body.verifier);

    if (!verifier) throw unavailable('This verifier cannot create sessions at the moment.');

    const slot = await this.live.reserve();

    if (!slot.ok) {
      throw apiError(503, 'UNAVAILABLE', 'Too many verification sessions are open; try again shortly.', { retryAfter: slot.retryAfterSeconds });
    }

    const created = await verifier.createSession({ scenario: body.scenario }).catch(async (error: unknown) => {
      await this.live.release(slot.member).catch(() => undefined);
      throw error;
    });

    if (!created.ok) {
      await this.live.release(slot.member);

      if (created.reason === 'unknown_scenario') throw apiError(404, 'NOT_FOUND', 'No such verifier or scenario.');

      this.verifiers.notListed(body.verifier);
      throw unavailable('This verifier is not in the trust list at the moment.');
    }

    const { session } = created;

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
  constructor(@Inject(VERIFIERS) private readonly verifiers: HostedVerifiers) {}

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

      return send(res, handled.response);
    }

    throw oauthError(400, 'invalid_request', 'the response is not acceptable');
  }
}
