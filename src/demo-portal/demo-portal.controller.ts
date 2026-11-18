import { Body, Controller, Get, HttpCode, Module, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { apiError, V1ErrorFilter } from '../common/http-errors';
import { RateLimit, RateLimitFailClosed } from '../common/rate-limit';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { StudentProfile } from './demo-accounts';
import { DemoPortalGuard, PortalSession, PortalSessionData, PortalSessions } from './portal-sessions';

class PortalLoginDto {
  @IsString()
  @MaxLength(64)
  username: string;

  @IsString()
  @MaxLength(128)
  password: string;
}

class CredentialsQueryDto {
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

/** Opaque cursor: the (issuedAt, id) of the last item of the previous page. */
const encodeCursor = (issuedAt: Date, id: string) =>
  Buffer.from(JSON.stringify([issuedAt.toISOString(), id])).toString('base64url');

function decodeCursor(cursor: string): { issuedAt: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    const issuedAt = new Date(String(at));

    if (typeof id !== 'string' || Number.isNaN(issuedAt.getTime())) throw new Error('bad cursor');

    return { issuedAt, id };
  } catch {
    throw apiError(400, 'VALIDATION_FAILED', 'cursor is not valid');
  }
}

/** School portal demo, first half (docs/vc-api.md §5); the offer routes come with issuance. */
@ApiTags('demo-school')
@Controller('demo/school')
@UseFilters(V1ErrorFilter)
// Without Redis there is neither a login limit nor a session store: refuse (503), never guess.
@RateLimitFailClosed()
export class DemoPortalController {
  constructor(
    private readonly sessions: PortalSessions,
    private readonly prisma: PrismaService
  ) {}

  @Post('login')
  @HttpCode(201)
  @RateLimit('login')
  login(@Body() body: PortalLoginDto) {
    return this.sessions.login(body.username, body.password);
  }

  /** Student: their own diplomas; registrar: every diploma of their issuer. */
  @Get('credentials')
  @ApiBearerAuth()
  @UseGuards(DemoPortalGuard)
  async credentials(@PortalSession() session: PortalSessionData, @Query() query: CredentialsQueryDto) {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const where: Prisma.VcIssuedCredentialWhereInput = {
      issuerName: session.issuerName,
      ...(session.role === 'student' ? { subjectRef: session.username } : {}),
      // Newest first; the next page continues strictly after the cursor's (issuedAt, id).
      ...(after
        ? { OR: [{ issuedAt: { lt: after.issuedAt } }, { issuedAt: after.issuedAt, id: { lt: after.id } }] }
        : {})
    };
    const page = await this.prisma.vcIssuedCredential.findMany({
      where,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1
    });
    const rows = page.slice(0, query.limit);
    const last = rows[rows.length - 1];
    // Names come from the accounts of the same issuer only.
    const accounts = await this.prisma.demoPortalAccount.findMany({
      where: { issuerName: session.issuerName, username: { in: [...new Set(rows.map((row) => row.subjectRef))] } }
    });
    const profiles = new Map(accounts.map((a) => [a.username, a.profile as unknown as Partial<StudentProfile>]));

    return {
      items: rows.map((row) => ({
        id: row.id,
        studentCode: profiles.get(row.subjectRef)?.maSinhVien ?? null,
        studentName: profiles.get(row.subjectRef)?.hoTen ?? null,
        issuedAt: row.issuedAt.toISOString(),
        status: row.status
      })),
      nextCursor: page.length > query.limit && last ? encodeCursor(last.issuedAt, last.id) : null
    };
  }
}

@Module({
  controllers: [DemoPortalController],
  providers: [PortalSessions, DemoPortalGuard],
  exports: [PortalSessions]
})
export class DemoPortalModule {}
