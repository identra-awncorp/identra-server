import { Body, Controller, Get, Header, HttpCode, Inject, Logger, Param, Post, Req, Res, UseFilters } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import type { PresentationVerifier } from '@identra/sdk-server';

import { apiError, oauthError, ProtocolErrorFilter, V1ErrorFilter } from '../common/http-errors';
import { RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { createRedisStateStore, StateStore } from '../common/state-store';
import { RedisService } from '../infrastructure/redis/redis.service';
import { RawRequest, RawResponse, sdkRequest, send } from './issuer.controllers';
import { VERIFIER_STATE_NAMESPACE, VERIFIERS, VerifierRegistry } from './verifiers';

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
  constructor(@Inject(VERIFIERS) private readonly verifiers: VerifierRegistry) {}

  @Post()
  @HttpCode(201)
  @RateLimit('sessionCreation')
  async create(@Body() body: CreateSessionDto) {
    const session = await this.verifiers.get(body.verifier)?.createSession({ scenario: body.scenario });

    if (!session) throw apiError(404, 'NOT_FOUND', 'No such verifier or scenario.');

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
  private readonly store: StateStore;

  constructor(
    @Inject(VERIFIERS) private readonly verifiers: VerifierRegistry,
    redis: RedisService
  ) {
    this.store = createRedisStateStore(redis.getClient(), VERIFIER_STATE_NAMESPACE);
  }

  /** The verifier whose session owns `requestId` (the SDK's documented `request:` record). */
  private async owner(requestId: string): Promise<{ verifier: PresentationVerifier; sessionId: string | null }> {
    for (const verifier of this.verifiers.values()) {
      const record = /^[A-Za-z0-9_-]{22}$/.test(requestId)
        ? await this.store.get(`vp:${verifier.clientId}:request:${requestId}`)
        : null;

      if (record !== null) return { verifier, sessionId: (JSON.parse(record) as { id?: string }).id ?? null };
    }

    const [only] = this.verifiers.values();

    if (!only) throw oauthError(404, 'not_found', 'unknown request');

    // Unknown everywhere: let the SDK answer (404 / invalid_request) in its own words.
    return { verifier: only, sessionId: null };
  }

  @Get('request/:requestId')
  async request(@Param('requestId') requestId: string, @Res() res: RawResponse) {
    send(res, await (await this.owner(requestId)).verifier.requestObject(requestId));
  }

  @Post('response/:requestId')
  @RateLimit('write')
  async response(@Param('requestId') requestId: string, @Req() req: RawRequest, @Res() res: RawResponse) {
    const { verifier, sessionId } = await this.owner(requestId);
    const answer = await verifier.handleResponse(requestId, sdkRequest(req));

    if (answer.status === 200 && sessionId) {
      const result = (await verifier.session(sessionId))?.result;
      const failing = result?.checks.find((check) => !check.ok && check.code !== 'SKIPPED')?.code;

      logger.log(`Presentation ${sessionId.slice(0, 8)}: ${result?.ok ? 'verified' : `failed${failing ? ` (${failing})` : ''}`}`);
    }

    send(res, answer);
  }
}
