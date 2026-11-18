import { createHash, randomBytes } from 'node:crypto';

import { CanActivate, ExecutionContext, Injectable, OnModuleInit, createParamDecorator } from '@nestjs/common';
import { DemoPortalRole } from '@prisma/client';
import * as argon2 from 'argon2';

import { apiError } from '../common/http-errors';
import { createRedisStateStore, StateStore } from '../common/state-store';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { PORTAL_PASSWORD_HASH } from './demo-accounts';

export const PORTAL_SESSION_SECONDS = 30 * 60;

export interface PortalSessionData {
  username: string;
  role: DemoPortalRole;
  issuerName: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function readBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(value ?? '');

  return match ? match[1]! : null;
}

/** Portal sign-in and opaque bearer sessions (Redis, 30 minutes; only a hash of the token is stored). */
@Injectable()
export class PortalSessions implements OnModuleInit {
  private readonly store: StateStore;
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService
  ) {
    this.store = createRedisStateStore(redis.getClient(), 'portal-session');
  }

  async onModuleInit() {
    // Verified against for unknown usernames, so they cost the same time as a wrong password.
    this.dummyHash = await argon2.hash(randomBytes(16).toString('hex'), PORTAL_PASSWORD_HASH);
  }

  async login(username: string, password: string) {
    const account = await this.prisma.demoPortalAccount.findUnique({ where: { username } });
    const valid = await argon2.verify(account?.passwordHash ?? this.dummyHash, password).catch(() => false);

    if (!account || !valid) {
      throw apiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    }

    const token = randomBytes(32).toString('base64url');
    const session: PortalSessionData = { username: account.username, role: account.role, issuerName: account.issuerName };
    const now = new Date();

    await this.store.put(hashToken(token), JSON.stringify(session), PORTAL_SESSION_SECONDS);

    return {
      token,
      expiresAt: new Date(now.getTime() + PORTAL_SESSION_SECONDS * 1000).toISOString(),
      serverTime: now.toISOString(),
      role: account.role,
      profile: account.profile
    };
  }

  async find(token: string): Promise<PortalSessionData | null> {
    const stored = await this.store.get(hashToken(token));

    return stored ? (JSON.parse(stored) as PortalSessionData) : null;
  }
}

interface PortalRequest {
  headers: Record<string, string | string[] | undefined>;
  portalSession?: PortalSessionData;
}

/** Requires a portal bearer token; 401 SESSION_EXPIRED when it is missing, unknown or expired. */
@Injectable()
export class DemoPortalGuard implements CanActivate {
  constructor(private readonly sessions: PortalSessions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PortalRequest>();
    const token = readBearer(req.headers.authorization);
    const session = token ? await this.sessions.find(token) : null;

    if (!session) {
      throw apiError(401, 'SESSION_EXPIRED', 'The portal session is missing or has expired; sign in again.');
    }

    req.portalSession = session;

    return true;
  }
}

/** The session DemoPortalGuard accepted. */
export const PortalSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<PortalRequest>().portalSession
);
