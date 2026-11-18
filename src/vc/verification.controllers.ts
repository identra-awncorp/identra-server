import { Body, Controller, Get, Header, HttpCode, Inject, Logger, Param, Post, Req, Res, UseFilters } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

import { apiError, oauthError, ProtocolErrorFilter, unavailable, V1ErrorFilter } from '../common/http-errors';
import { RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { RawRequest, RawResponse, sdkRequest, send } from './issuer.controllers';
import { VERIFIER_MONITOR, VerifierMonitor, VERIFIERS, VerifierRegistry } from './verifiers';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const logger = new Logger('Verification');

class CreateSessionDto {
  @IsString()
  @Matches(NAME)
  verifier: string;

  @IsString()
  @Matches(NAME)
  scenario: string;
}

/** Verification sessions for the website (docs/vc-api.md §6). */
@ApiTags('verification')
@Controller('verification/sessions')
@UseFilters(V1ErrorFilter)
// Sessions live in Redis: without it there is nothing to create or read (503).
@RateLimitFailClosed()
export class VerificationSessionsController {
  constructor(
    @Inject(VERIFIERS) private readonly verifiers: VerifierRegistry,
    @Inject(VERIFIER_MONITOR) private readonly monitor: VerifierMonitor
  ) {}

  @Post()
  @HttpCode(201)
  @RateLimit('sessionCreation')
  async create(@Body() body: CreateSessionDto) {
    const verifier = this.verifiers.get(body.verifier);
    const created = verifier ? await verifier.createSession({ scenario: body.scenario }) : null;

    if (!created || (!created.ok && created.reason === 'unknown_scenario')) {
      throw apiError(404, 'NOT_FOUND', 'No such verifier or scenario.');
    }

    this.monitor.listing(body.verifier, created.ok);

    if (!created.ok) throw unavailable('This verifier is not in the trust list at the moment.');

    const { session } = created;

    // requestId is never handed out on its own: it is inside the QR, which only a wallet reads.
    return { id: session.id, qr: session.qr, expiresAt: session.expiresAt, serverTime: session.serverTime };
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id') id: string) {
    for (const verifier of this.verifiers.values()) {
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
  constructor(@Inject(VERIFIERS) private readonly verifiers: VerifierRegistry) {}

  @Get('request/:requestId')
  async request(@Param('requestId') requestId: string, @Res() res: RawResponse) {
    // Each verifier answers null for request ids it does not hold.
    for (const verifier of this.verifiers.values()) {
      const answer = await verifier.requestObject(requestId);

      if (answer) return send(res, answer);
    }

    throw oauthError(404, 'not_found', 'unknown or finished request');
  }

  @Post('response/:requestId')
  @RateLimit('write')
  async response(@Param('requestId') requestId: string, @Req() req: RawRequest, @Res() res: RawResponse) {
    const request = sdkRequest(req);

    for (const verifier of this.verifiers.values()) {
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
