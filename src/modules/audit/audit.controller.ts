import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('activity')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listActivity(@CurrentUser() user: User, @Query() query: PaginationQueryDto) {
    return this.auditService.listActivity(user.id, query);
  }
}
