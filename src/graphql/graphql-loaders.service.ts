import { Injectable } from '@nestjs/common';
import { CredentialAttribute, Issuer } from '@prisma/client';
import DataLoader from 'dataloader';

import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { GraphqlLoaders } from './graphql.context';

@Injectable()
export class GraphqlLoadersService {
  constructor(private readonly prisma: PrismaService) {}

  createLoaders(): GraphqlLoaders {
    return {
      issuerById: new DataLoader<string, Issuer | null>((ids) => this.loadIssuers(ids)),
      attributesByCredentialId: new DataLoader<string, CredentialAttribute[]>((credentialIds) =>
        this.loadCredentialAttributes(credentialIds)
      )
    };
  }

  private async loadIssuers(ids: readonly string[]): Promise<Array<Issuer | null>> {
    const uniqueIds = [...new Set(ids)];
    const issuers = await this.prisma.issuer.findMany({
      where: {
        id: {
          in: uniqueIds
        }
      }
    });
    const byId = new Map(issuers.map((issuer) => [issuer.id, issuer]));

    return ids.map((id) => byId.get(id) ?? null);
  }

  private async loadCredentialAttributes(
    credentialIds: readonly string[]
  ): Promise<CredentialAttribute[][]> {
    const uniqueCredentialIds = [...new Set(credentialIds)];
    const attributes = await this.prisma.credentialAttribute.findMany({
      where: {
        credentialId: {
          in: uniqueCredentialIds
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    });
    const byCredentialId = new Map<string, CredentialAttribute[]>();

    for (const attribute of attributes) {
      const group = byCredentialId.get(attribute.credentialId) ?? [];
      group.push(attribute);
      byCredentialId.set(attribute.credentialId, group);
    }

    return credentialIds.map((credentialId) => byCredentialId.get(credentialId) ?? []);
  }
}
