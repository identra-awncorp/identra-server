import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CredentialsService } from './credentials.service';

@ApiTags('credentials')
@Controller('credentials')
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listCredentials(@CurrentUser() user: User, @Query() query: PaginationQueryDto) {
    return this.credentialsService.listCredentials(user.id, query);
  }
}
