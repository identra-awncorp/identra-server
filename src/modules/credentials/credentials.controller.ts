import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CredentialsService } from './credentials.service';

@ApiTags('credentials')
@Controller('credentials')
export class CredentialsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Get()
  listCredentials(@Query() query: PaginationQueryDto) {
    return this.credentialsService.listCredentials(query);
  }
}
