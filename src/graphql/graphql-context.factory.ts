import { Injectable } from '@nestjs/common';

import { GraphqlContext, GraphqlHttpRequest, GraphqlIdentity, GraphqlRole } from './graphql.context';
import { GraphqlLoadersService } from './graphql-loaders.service';

@Injectable()
export class GraphqlContextFactory {
  constructor(private readonly loaders: GraphqlLoadersService) {}

  create(req?: GraphqlHttpRequest): GraphqlContext {
    const identity = this.createIdentity(req);

    return {
      req,
      identity,
      loaders: this.loaders.createLoaders()
    };
  }

  private createIdentity(req?: GraphqlHttpRequest): GraphqlIdentity {
    const userId = readHeader(req, 'x-identra-user-id') ?? null;
    const role = toRole(readHeader(req, 'x-identra-role'));
    const scopes = toScopes(readHeader(req, 'x-identra-scopes'));
    const ip = readClientIp(req);
    const highAssurance =
      readHeader(req, 'x-identra-session-assurance')?.toLowerCase() === 'high' ||
      scopes.has('session:high_assurance');

    return {
      userId,
      role,
      scopes,
      ip,
      highAssurance,
      rateLimitKey: userId ? `user:${userId}` : `ip:${ip}`
    };
  }
}

function readHeader(req: GraphqlHttpRequest | undefined, name: string): string | undefined {
  const value = req?.headers?.[name.toLowerCase()] ?? req?.headers?.[name];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function toRole(value: string | undefined): GraphqlRole {
  if (value === 'admin' || value === 'service' || value === 'user') {
    return value;
  }

  return 'anonymous';
}

function toScopes(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
}

function readClientIp(req: GraphqlHttpRequest | undefined): string {
  const forwardedFor = readHeader(req, 'x-forwarded-for');

  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  return req?.ip ?? req?.socket?.remoteAddress ?? 'unknown';
}
