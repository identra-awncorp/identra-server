import { Injectable } from '@nestjs/common';
import { CredentialStatus } from '@prisma/client';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const credentialStatusMap: Record<CredentialStatus, string> = {
  VERIFIED: 'verified',
  PENDING: 'pending',
  EXPIRED: 'expired',
  FAILED: 'failed',
  UNAVAILABLE: 'unavailable'
};

@Injectable()
export class CredentialsService {
  constructor(private readonly prisma: PrismaService) {}

  async listCredentials(holderId: string, query: PaginationQueryDto) {
    const credentials = await this.prisma.credential.findMany({
      where: { holderId },
      include: {
        issuer: {
          select: {
            did: true,
            name: true
          }
        },
        attributes: {
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset
    });

    return {
      data: credentials.map((credential) => ({
        id: credential.id,
        title: credential.title,
        type: credential.type,
        issuer: credential.issuer,
        status: credentialStatusMap[credential.status],
        issuedAt: credential.issuedAt?.toISOString() ?? null,
        expiresAt: credential.expiresAt?.toISOString() ?? null,
        attributes: credential.attributes.map((attribute) => ({
          id: attribute.id,
          label: attribute.label,
          value: attribute.value,
          sensitive: attribute.isSensitive
        }))
      }))
    };
  }
}
