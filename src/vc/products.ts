import { randomBytes } from 'node:crypto';

import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  decodeCredentialUnverified,
  parseDigitalLinkPath,
  productEventHash,
  type StatusChecker,
  type TrustRegistry
} from '@identra/sdk-core';
import { checkProductEventForStorage } from '@identra/sdk-server';

import { OrgApiKeyHash } from '../config/env.validation';
import { allowAnyOrigin, apiError, HttpResponse, unavailable, V1ErrorFilter } from '../common/http-errors';
import { decodeCursor, encodeCursor } from '../demo-portal/demo-portal.controller';
import { RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { PRODUCT_ISSUERS } from './hosted-issuers';
import { orgOfApiKey } from './vc.controllers';
import { PKI, Pki, STATUS_CHECKER, TRUST_REGISTRY } from './vc.providers';
import { readBearer } from '../demo-portal/portal-sessions';

const STATUS_URI = /^(.+)\/status\/([1-9][0-9]{0,8})$/;

interface ProductRequest {
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  productOrg?: string;
}

/**
 * The product of the path, parsed by the SDK's Digital Link parser from the RAW path segments, so
 * the URL form and the stored form cannot diverge (percent-decoded exactly once, upper-case
 * escapes only, no double encoding). 400 VALIDATION_FAILED otherwise.
 */
function productOf(req: ProductRequest): { gtin: string; serial: string } {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0]!;
  const m = /\/products\/([^/]+)\/([^/]+)\/events$/.exec(path);
  const product = m ? parseDigitalLinkPath(`/01/${m[1]}/21/${m[2]}`) : null;

  if (!product) throw apiError(400, 'VALIDATION_FAILED', 'gtin must be a GTIN-14 with a valid check digit and serial a GS1 AI (21) value');

  return product;
}

/** An SDK verification code as a safe envelope field: upper-case letters, digits and underscores only. */
const safeCode = (code: string | null | undefined) => (code && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'INVALID');

/** 409 CONFLICT or 400 VALIDATION_FAILED, with the SDK's code as `reason` and the failing event index. */
const refusal = (status: 400 | 409, reason: string, index: number | null, message: string) =>
  apiError(status, status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED', message, { details: { reason: safeCode(reason), index } });

/** The store of product lifecycle events (docs/vc-api.md §7, ADR-0012): not an authority. */
@Injectable()
export class ProductEventsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PKI) private readonly pki: Pki,
    @Inject(TRUST_REGISTRY) private readonly trustRegistry: TrustRegistry,
    @Inject(STATUS_CHECKER) private readonly statusChecker: StatusChecker
  ) {}

  /** The verification the store and the provisioning use: the server's own lists, in-process. */
  verifyOptions() {
    const { verifier, hasher, chainValidator, clock } = this.pki;

    return { verifier, hasher, chainValidator, trustRegistry: this.trustRegistry, statusChecker: this.statusChecker, now: clock.now() };
  }

  /** The stored events of a product, in chain order, exactly as stored (also when tampered with). */
  async events(gtin: string, serial: string): Promise<string[]> {
    const rows = await this.prisma.productEvent.findMany({ where: { gtin, serial }, orderBy: { seq: 'asc' }, select: { compact: true } });

    return rows.map((row) => row.compact);
  }

  /**
   * Keeps `compact` as the next event of the product after `checkProductEventForStorage`: the
   * stored chain must verify completely and the candidate extend it by exactly the next stage.
   * `actingOrg` (the API key's organisation; null for in-process provisioning) must have signed
   * it. Its status entry must be one this server allocated for that issuer and not used by
   * another event. The insert is the arbiter of concurrent posts: UNIQUE (gtin, serial, seq).
   */
  async store(input: { gtin: string; serial: string; compact: string; actingOrg: string | null }): Promise<{ seq: number; id: string }> {
    const { gtin, serial, compact } = input;
    let claimedIssuer: string | null = null;

    try {
      const iss = decodeCredentialUnverified(compact).payload['iss'];

      claimedIssuer = PRODUCT_ISSUERS.find((name) => iss === this.pki.issuerUri(name)) ?? null;
    } catch {
      claimedIssuer = null;
    }

    // Who claims to have signed it (verified below): the API key must be that organisation's.
    if (input.actingOrg !== null && claimedIssuer !== null && input.actingOrg !== claimedIssuer) {
      throw apiError(403, 'FORBIDDEN', 'This API key belongs to another organisation than the event issuer.');
    }

    const existing = await this.events(gtin, serial);
    const check = await checkProductEventForStorage({ gtin, serial, existing, candidate: compact }, this.verifyOptions());

    if (!check.ok) {
      if (check.index !== null && check.index < existing.length) {
        throw refusal(409, check.code, check.index, 'The stored chain of this product does not verify; it cannot be extended.');
      }

      if (check.index !== null && check.code === 'CHAIN_BROKEN') {
        throw refusal(409, check.code, check.index, 'The event does not extend this product by its next stage.');
      }

      throw refusal(400, check.code, check.index, 'The event does not verify.');
    }

    if (claimedIssuer === null) throw refusal(400, 'ISSUER_NOT_TRUSTED', existing.length, 'The event is not from a product issuer hosted here.');
    // M3: its status entry lives in a list this server could not publish.
    if (this.pki.unavailable.has(claimedIssuer)) throw unavailable('The status lists of this issuer cannot be signed at the moment.');

    // Verified now: the claims below are authenticated.
    const payload = decodeCredentialUnverified(compact).payload as {
      cong_doan: string;
      status: { status_list: { uri: string; idx: number } };
    };
    const ref = payload.status.status_list;
    const m = STATUS_URI.exec(ref.uri);
    const n = m && m[1] === this.pki.issuerUri(claimedIssuer) ? Number(m[2]) : NaN;

    if (!Number.isSafeInteger(n) || !(await this.isAllocated(claimedIssuer, n, ref.idx))) {
      throw refusal(400, 'STATUS_NOT_ALLOCATED', existing.length, 'The event status entry was not allocated by this server.');
    }

    const id = randomBytes(16).toString('base64url');

    try {
      await this.prisma.productEvent.create({
        data: {
          id,
          gtin,
          serial,
          seq: existing.length,
          congDoan: payload.cong_doan,
          issuerName: claimedIssuer,
          compact,
          compactHash: await productEventHash(compact, this.pki.hasher),
          statusListNumber: n,
          statusIndex: ref.idx
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // UNIQUE (issuerName, statusListNumber, statusIndex): the entry belongs to another event.
        if (String(error.meta?.target).includes('statusIndex')) {
          throw refusal(400, 'STATUS_ALREADY_USED', existing.length, 'The event status entry is already used by another event.');
        }

        throw refusal(409, 'CHAIN_BROKEN', existing.length, 'Another event was stored for this stage first.');
      }

      throw error;
    }

    return { seq: existing.length, id };
  }

  private async isAllocated(issuer: string, n: number, idx: number): Promise<boolean> {
    const row = await this.prisma.vcStatusIndex.findUnique({
      where: { issuerName_listNumber_idx: { issuerName: issuer, listNumber: n, idx } }
    });

    return row !== null;
  }
}

/** The organisation of a valid back-office API key (any product issuer), else 401. */
@Injectable()
class ProductApiKeyGuard implements CanActivate {
  private readonly keys: OrgApiKeyHash[];

  constructor(config: ConfigService) {
    this.keys = config.getOrThrow<OrgApiKeyHash[]>('IDENTRA_ORG_API_KEY_HASHES');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ProductRequest>();
    const token = readBearer(req.headers.authorization);
    const org = token ? orgOfApiKey(this.keys, token) : null;

    if (!org) throw apiError(401, 'SESSION_EXPIRED', 'An organisation API key is required.');
    if (!PRODUCT_ISSUERS.includes(org)) throw apiError(403, 'FORBIDDEN', 'This organisation does not issue product events.');

    req.productOrg = org;

    return true;
  }
}

class StoreEventDto {
  @IsString()
  @MaxLength(16_384)
  credential: string;
}

/** GET / POST /v1/products/:gtin/:serial/events (docs/vc-api.md §7). */
@ApiTags('products')
@Controller('products')
@UseFilters(V1ErrorFilter)
export class ProductEventsController {
  constructor(private readonly products: ProductEventsService) {}

  // Public; never cached: the page must see a revocation or a tampered store at once.
  @Get(':gtin/:serial/events')
  @RateLimit('publicResource')
  async list(@Req() req: ProductRequest, @Res({ passthrough: true }) res: HttpResponse) {
    const { gtin, serial } = productOf(req);
    const events = await this.products.events(gtin, serial);

    allowAnyOrigin(res);
    res.setHeader('Cache-Control', 'no-store');

    if (events.length === 0) throw apiError(404, 'NOT_FOUND', 'No events for this product.');

    return { gtin, serial, serverTime: new Date().toISOString(), events };
  }

  @Post(':gtin/:serial/events')
  @HttpCode(201)
  @ApiBearerAuth()
  @RateLimit('write')
  @RateLimitFailClosed()
  @UseGuards(ProductApiKeyGuard)
  async store(@Req() req: ProductRequest, @Body() body: StoreEventDto) {
    const { gtin, serial } = productOf(req);

    // `id` is what POST /v1/issuers/:name/credentials/:id/status takes (M2).
    return this.products.store({ gtin, serial, compact: body.credential, actingOrg: req.productOrg! });
  }
}

class EventsQueryDto {
  @IsOptional()
  @Matches(/^[0-9]{14}$/)
  gtin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  serial?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,200}$/)
  cursor?: string;
}

/**
 * GET /v1/issuers/:name/credentials (docs/vc-api.md §7): a product organisation's own events,
 * newest first, so an operator can find the id to revoke. Its API key only.
 */
@ApiTags('products')
@Controller('issuers')
@UseFilters(V1ErrorFilter)
export class ProductEventListController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':name/credentials')
  @ApiBearerAuth()
  @UseGuards(ProductApiKeyGuard)
  async list(@Req() req: ProductRequest, @Param('name') name: string, @Query() query: EventsQueryDto) {
    if (!PRODUCT_ISSUERS.includes(name)) throw apiError(404, 'NOT_FOUND', 'No such product issuer.');
    if (req.productOrg !== name) throw apiError(403, 'FORBIDDEN', 'This API key belongs to another organisation.');

    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const page = await this.prisma.productEvent.findMany({
      where: {
        issuerName: name,
        ...(query.gtin !== undefined ? { gtin: query.gtin } : {}),
        ...(query.serial !== undefined ? { serial: query.serial } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.issuedAt } }, { createdAt: after.issuedAt, id: { lt: after.id } }] } : {})
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: { id: true, gtin: true, serial: true, seq: true, congDoan: true, status: true, createdAt: true }
    });
    const rows = page.slice(0, query.limit);
    const last = rows[rows.length - 1];

    return {
      items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      nextCursor: page.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null
    };
  }
}

export const productProviders = [ProductEventsService];
export const productControllers = [ProductEventsController, ProductEventListController];
