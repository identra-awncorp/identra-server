import { Injectable, NotFoundException } from '@nestjs/common';
import { DemoScenarioStatus } from '@prisma/client';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const demoScenarioStatusMap: Record<DemoScenarioStatus, string> = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  ARCHIVED: 'archived'
};

@Injectable()
export class DemoScenariosService {
  constructor(private readonly prisma: PrismaService) {}

  async listScenarios() {
    const scenarios = await this.prisma.demoScenario.findMany({
      orderBy: { createdAt: 'asc' }
    });

    return {
      data: scenarios.map((scenario) => ({
        id: scenario.id,
        slug: scenario.slug,
        title: scenario.title,
        description: scenario.description,
        status: demoScenarioStatusMap[scenario.status],
        payload: scenario.payload
      }))
    };
  }

  async startScenario(slug: string) {
    const scenario = await this.prisma.demoScenario.findUnique({
      where: { slug }
    });

    if (!scenario) {
      throw new NotFoundException(`Demo scenario not found: ${slug}`);
    }

    return {
      data: {
        scenarioId: scenario.id,
        slug: scenario.slug,
        status: 'started',
        startedAt: new Date().toISOString(),
        nextEvents: ['credential.issue.requested', 'wallet.sync.requested']
      }
    };
  }
}
