import { createHash, timingSafeEqual } from 'node:crypto';

import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  StreamableFile,
  UseFilters,
  UseGuards
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { VcCredentialStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

import { OrgApiKeyHash } from '../config/env.validation';
import { allowAnyOrigin, apiError, HttpResponse, ProtocolErrorFilter, V1ErrorFilter } from '../common/http-errors';
import { RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { PortalSessions, readBearer } from '../demo-portal/portal-sessions';
import type { StatusListService, TrustListService } from '@identra/sdk-server';
import { VcCredentialsService } from './vc-credentials.service';
import { STATUS_LIST_SERVICE, StatusListBusyError, TRUST_LIST_SERVICE } from './vc.providers';

const ISSUER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LIST_NUMBER = /^[1-9][0-9]{0,8}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{22}$/;

// Sent as bytes: a string body would make Express append "; charset=utf-8" to the media type.
const signedResource = (token: string, type: string) => new StreamableFile(Buffer.from(token), { type });

/** GET /trust-list (docs/vc-api.md §3): public, signed, cacheable for 5 minutes. */
@ApiTags('trust')
@Controller('trust-list')
@UseFilters(ProtocolErrorFilter)
@RateLimit('publicResource')
export class TrustListController {
  constructor(@Inject(TRUST_LIST_SERVICE) private readonly trustList: TrustListService) {}

  @Get()
  async get(@Res({ passthrough: true }) res: HttpResponse): Promise<StreamableFile> {
    let token: string;

    try {
      token = await this.trustList.token();
    } catch {
      throw new ServiceUnavailableException('No valid trust list is available.');
    }

    res.setHeader('Cache-Control', 'public, max-age=300');
    allowAnyOrigin(res);

    return signedResource(token, 'application/jwt');
  }
}

/** GET /issuers/:name/status/:n (docs/vc-api.md §3): public, signed, cacheable for 1 minute. */
@ApiTags('trust')
@Controller('issuers')
@UseFilters(ProtocolErrorFilter)
export class StatusListController {
  constructor(@Inject(STATUS_LIST_SERVICE) private readonly statusLists: StatusListService) {}

  @Get(':name/status/:n')
  @RateLimit('publicResource')
  async get(@Param('name') name: string, @Param('n') n: string, @Res({ passthrough: true }) res: HttpResponse) {
    let token: string | null = null;

    try {
      token = ISSUER_NAME.test(name) && LIST_NUMBER.test(n) ? await this.statusLists.token(name, Number(n)) : null;
    } catch (error) {
      if (!(error instanceof StatusListBusyError)) throw error;

      res.setHeader('Retry-After', '1');
      throw new ServiceUnavailableException('The status list is being updated.');
    }

    if (token === null) throw new NotFoundException('No such status list.');

    res.setHeader('Cache-Control', 'public, max-age=60');
    allowAnyOrigin(res);

    return signedResource(token, 'application/statuslist+jwt');
  }
}

interface AdminRequest {
  headers: Record<string, string | string[] | undefined>;
  params: { name?: string };
}

/**
 * Issuer administrators only: the organisation's back-office API key, or a portal session with
 * the registrar role of that issuer. API keys are compared as SHA-256 digests in constant time.
 */
@Injectable()
export class IssuerAdminGuard implements CanActivate {
  private readonly keys: Array<{ org: string; digest: Buffer }>;

  constructor(
    config: ConfigService,
    private readonly sessions: PortalSessions
  ) {
    this.keys = config
      .getOrThrow<OrgApiKeyHash[]>('IDENTRA_ORG_API_KEY_HASHES')
      .map(({ org, hash }) => ({ org, digest: Buffer.from(hash, 'hex') }));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const issuer = req.params.name ?? '';
    const token = readBearer(req.headers.authorization);

    if (!token) throw apiError(401, 'SESSION_EXPIRED', 'A bearer token is required.');

    const digest = createHash('sha256').update(token).digest();
    // Every configured key is compared, matched or not.
    const keyOrgs = this.keys.filter((key) => timingSafeEqual(key.digest, digest)).map((key) => key.org);

    if (keyOrgs.length > 0) {
      if (keyOrgs.includes(issuer)) return true;

      throw apiError(403, 'FORBIDDEN', 'This API key belongs to another organisation.');
    }

    const session = await this.sessions.find(token);

    if (!session) throw apiError(401, 'SESSION_EXPIRED', 'The token is unknown or has expired.');
    if (session.role !== 'registrar' || session.issuerName !== issuer) {
      throw apiError(403, 'FORBIDDEN', 'Only a registrar of this issuer may change credential statuses.');
    }

    return true;
  }
}

class ChangeStatusDto {
  @IsIn(['valid', 'suspended', 'revoked'])
  status: VcCredentialStatus;
}

/** POST /v1/issuers/:name/credentials/:credentialId/status (docs/vc-api.md §3). */
@ApiTags('trust')
@Controller('issuers')
@UseFilters(V1ErrorFilter)
@RateLimitFailClosed()
export class CredentialStatusController {
  constructor(private readonly credentials: VcCredentialsService) {}

  @Post(':name/credentials/:credentialId/status')
  @HttpCode(200)
  @ApiBearerAuth()
  @RateLimit('write')
  @UseGuards(IssuerAdminGuard)
  change(@Param('name') name: string, @Param('credentialId') id: string, @Body() body: ChangeStatusDto) {
    if (!CREDENTIAL_ID.test(id)) throw apiError(404, 'NOT_FOUND', 'No such credential for this issuer.');

    return this.credentials.changeStatus(name, id, body.status);
  }
}
