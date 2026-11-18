import { Body, Controller, Get, HttpCode, Module, Post, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

import { V1ErrorFilter } from '../common/http-errors';
import { RateLimit } from '../common/rate-limit';
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

/** School portal demo, first half (docs/vc-api.md §5); the offer routes come with issuance. */
@ApiTags('demo-school')
@Controller('demo/school')
@UseFilters(V1ErrorFilter)
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
  async credentials(@PortalSession() session: PortalSessionData) {
    const rows = await this.prisma.vcIssuedCredential.findMany({
      where: {
        issuerName: session.issuerName,
        ...(session.role === 'student' ? { subjectRef: session.username } : {})
      },
      orderBy: { issuedAt: 'desc' }
    });
    const accounts = await this.prisma.demoPortalAccount.findMany({
      where: { username: { in: [...new Set(rows.map((row) => row.subjectRef))] } }
    });
    const profiles = new Map(accounts.map((a) => [a.username, a.profile as unknown as Partial<StudentProfile>]));

    return {
      items: rows.map((row) => ({
        id: row.id,
        studentCode: profiles.get(row.subjectRef)?.maSinhVien ?? null,
        studentName: profiles.get(row.subjectRef)?.hoTen ?? null,
        issuedAt: row.issuedAt.toISOString(),
        status: row.status
      }))
    };
  }
}

@Module({
  controllers: [DemoPortalController],
  providers: [PortalSessions, DemoPortalGuard],
  exports: [PortalSessions]
})
export class DemoPortalModule {}
