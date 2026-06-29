import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class MiniAppsService {
  constructor(private readonly prisma: PrismaService) {}

  async listMiniApps() {
    const miniApps = await this.prisma.miniApp.findMany({
      where: { isEnabled: true },
      orderBy: { createdAt: 'asc' }
    });

    return { data: miniApps };
  }
}
