import { HttpException, Injectable } from '@nestjs/common';
import { GraphQLError } from 'graphql';

import { AuthService } from '../modules/auth/auth.service';
import { GraphqlContext, GraphqlHttpRequest, GraphqlIdentity } from './graphql.context';
import { GraphqlLoadersService } from './graphql-loaders.service';

@Injectable()
export class GraphqlContextFactory {
  constructor(
    private readonly loaders: GraphqlLoadersService,
    private readonly authService: AuthService
  ) {}

  async create(req?: GraphqlHttpRequest): Promise<GraphqlContext> {
    const identity = await this.createIdentity(req);

    return {
      req,
      identity,
      loaders: this.loaders.createLoaders()
    };
  }

  // Identity comes only from a verified bearer JWT (same check as JwtAuthGuard). No request
  // header can set the user, role, scopes or session assurance; nothing grants admin/service yet.
  private async createIdentity(req?: GraphqlHttpRequest): Promise<GraphqlIdentity> {
    const ip = req?.ip ?? req?.socket?.remoteAddress ?? 'unknown';
    const authorization = readHeader(req, 'authorization');
    const anonymous: GraphqlIdentity = {
      userId: null,
      role: 'anonymous',
      scopes: new Set(),
      ip,
      highAssurance: false,
      rateLimitKey: `ip:${ip}`
    };

    if (!authorization) {
      return anonymous;
    }

    try {
      const auth = await this.authService.authenticateAccessToken(authorization);

      return {
        userId: auth.user.id,
        role: 'user',
        scopes: new Set(auth.claims.scopes),
        ip,
        highAssurance: false,
        rateLimitKey: `user:${auth.user.id}`
      };
    } catch (error) {
      if (error instanceof HttpException) {
        // A credential was sent but is invalid: say so instead of silently downgrading.
        const body = error.getResponse() as { code?: string; message?: string };

        throw new GraphQLError(body.message ?? 'Unauthorized', {
          extensions: { code: 'UNAUTHENTICATED', reason: body.code, http: { status: 401 } }
        });
      }

      throw error;
    }
  }
}

function readHeader(req: GraphqlHttpRequest | undefined, name: string): string | undefined {
  const value = req?.headers?.[name];

  return Array.isArray(value) ? value[0] : value;
}
