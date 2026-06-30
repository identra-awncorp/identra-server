import { CredentialAttribute, Issuer } from '@prisma/client';
import DataLoader from 'dataloader';

export interface GraphqlHttpRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
}

export type GraphqlRole = 'anonymous' | 'user' | 'admin' | 'service';

export interface GraphqlIdentity {
  userId: string | null;
  role: GraphqlRole;
  scopes: Set<string>;
  ip: string;
  rateLimitKey: string;
  highAssurance: boolean;
}

export interface GraphqlLoaders {
  issuerById: DataLoader<string, Issuer | null>;
  attributesByCredentialId: DataLoader<string, CredentialAttribute[]>;
}

export interface GraphqlContext {
  req?: GraphqlHttpRequest;
  identity: GraphqlIdentity;
  loaders: GraphqlLoaders;
  requestCost?: number;
  rateLimit?: {
    limit: number;
    used: number;
    remaining: number;
    resetAt: Date;
  };
}
