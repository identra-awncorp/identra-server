import { Injectable } from '@nestjs/common';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listActivity(userId: string, query: PaginationQueryDto) {
    const logs = await this.prisma.activityLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset
    });

    return {
      data: logs.map((log) => ({
        id: log.id,
        userId: log.userId,
        type: log.type.toLowerCase(),
        status: log.status?.toLowerCase() ?? null,
        title: log.title,
        description: log.description,
        partner: log.partner,
        unread: log.unread,
        isDemo: log.isDemo,
        createdAt: log.createdAt.toISOString(),
        expiresAt: log.expiresAt?.toISOString() ?? null
      }))
    };
  }
}
