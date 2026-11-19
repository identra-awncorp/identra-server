import { createHash, randomBytes } from 'node:crypto';

import { CanActivate, ExecutionContext, Injectable, OnModuleInit, createParamDecorator } from '@nestjs/common';
import { DemoPortalRole } from '@prisma/client';
import * as argon2 from 'argon2';
import Redis from 'ioredis';

import { apiError, unavailable } from '../common/http-errors';
import { createRedisStateStore, StateStore } from '../common/state-store';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RedisService } from '../infrastructure/redis/redis.service';
import { PORTAL_PASSWORD_HASH } from './demo-accounts';

export const PORTAL_SESSION_SECONDS = 30 * 60;

export interface PortalSessionData {
  username: string;
  role: DemoPortalRole;
  issuerName: string;
  /**
   * Names this session in what it creates (offers, the credentials issued from them): SHA-256 of
   * the token under its own label, so it is neither the token nor the session's Redis key.
   */
  sessionHash: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const sessionHashOf = (token: string) => createHash('sha256').update(`portal-session-ref:${token}`).digest('base64url');

/**
 * Password hashes verified at once (argon2id, 19 MiB, about 50 ms of the one CPU each). Beyond that
 * a sign-in is refused with 503 and Retry-After instead of queueing: rotating addresses cannot turn
 * the login route into a CPU sink for the whole box. The per-client limit runs before (a guard).
 */
export const MAX_CONCURRENT_HASHES = 2;

/**
 * Wrong passwords for one registrar account (its name is public) within the window; beyond that the
 * account's sign-in answers 429 until the window ends, even with the right password, so guessing
 * gets no further. Students are never counted: their password is public, and a third party must
 * not be able to lock them out. A third party can delay the registrar's own sign-in this way.
 */
export const REGISTRAR_FAILURES = 10;
export const REGISTRAR_WINDOW_SECONDS = 15 * 60;

export function readBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(value ?? '');

  return match ? match[1]! : null;
}

/** Portal sign-in and opaque bearer sessions (Redis, 30 minutes; only a hash of the token is stored). */
@Injectable()
export class PortalSessions implements OnModuleInit {
  private readonly store: StateStore;
  private readonly redis: Redis;
  private dummyHash = '';
  private hashing = 0;

  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService
  ) {
    this.store = createRedisStateStore(redis.getClient(), 'portal-session');
    this.redis = redis.getClient();
  }

  async onModuleInit() {
    // Verified against for unknown usernames, so they cost the same time as a wrong password.
    this.dummyHash = await argon2.hash(randomBytes(16).toString('hex'), PORTAL_PASSWORD_HASH);
  }

  async login(username: string, password: string) {
    const account = await this.prisma.demoPortalAccount.findUnique({ where: { username } });
    const failures = account?.role === 'registrar' ? `state:portal-registrar-failures:${account.username}` : null;

    if (failures) {
      const [[, count], [, pttl]] = (await this.redis.multi().get(failures).pttl(failures).exec().catch(() => {
        throw unavailable();
      })) as [[null, string | null], [null, number]];

      if (Number(count) >= REGISTRAR_FAILURES) {
        throw apiError(429, 'RATE_LIMITED', 'Too many failed sign-ins for this account; try again later.', { retryAfter: Math.max(1, Math.ceil(pttl / 1000)) });
      }
    }

    if (this.hashing >= MAX_CONCURRENT_HASHES) throw apiError(503, 'UNAVAILABLE', 'Too many sign-ins at once; try again.', { retryAfter: 1 });

    this.hashing += 1;
    // Unknown users are verified against a dummy hash: the same time as a wrong password.
    const valid = await argon2
      .verify(account?.passwordHash ?? this.dummyHash, password)
      .catch(() => false)
      .finally(() => (this.hashing -= 1));

    if (!account || !valid) {
      if (failures) await this.redis.multi().incr(failures).expire(failures, REGISTRAR_WINDOW_SECONDS, 'NX').exec().catch(() => undefined);

      throw apiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    }

    const token = randomBytes(32).toString('base64url');
    const session: Omit<PortalSessionData, 'sessionHash'> = { username: account.username, role: account.role, issuerName: account.issuerName };
    const now = new Date();

    await this.store.put(hashToken(token), JSON.stringify(session), PORTAL_SESSION_SECONDS).catch(() => {
      throw unavailable();
    });

    return {
      token,
      expiresAt: new Date(now.getTime() + PORTAL_SESSION_SECONDS * 1000).toISOString(),
      serverTime: now.toISOString(),
      role: account.role,
      profile: account.profile
    };
  }

  async find(token: string): Promise<PortalSessionData | null> {
    // Redis down: 503, never a 500 (or a 401 that would send the user to sign in again).
    const stored = await this.store.get(hashToken(token)).catch(() => {
      throw unavailable();
    });

    return stored ? { ...(JSON.parse(stored) as Omit<PortalSessionData, 'sessionHash'>), sessionHash: sessionHashOf(token) } : null;
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
