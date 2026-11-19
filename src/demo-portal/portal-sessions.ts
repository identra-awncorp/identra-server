import { createHash, randomBytes } from 'node:crypto';

import { CanActivate, ExecutionContext, Injectable, OnModuleInit, createParamDecorator } from '@nestjs/common';
import { DemoPortalRole } from '@prisma/client';
import * as argon2 from 'argon2';
import Redis from 'ioredis';

import { apiError, unavailable } from '../common/http-errors';
import { clientOf, NETWORK_SHARES } from '../common/live-cap';
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
 * Wrong passwords for a registrar account (its name is public), counted per client (an IPv4
 * address or IPv6 /56; its /48: NETWORK_SHARES ×) and, as a backstop, for the account from
 * everywhere, each in a 15-minute window. A client over its count gets 429 for that account until
 * its window ends, even with the right password, so guessing gets no further; it locks out only
 * itself. The account-wide backstop (only reached by many addresses) refuses every client.
 * Students are never counted: their password is public and nobody may lock them out.
 */
export const REGISTRAR_FAILURES = 10;
export const REGISTRAR_ACCOUNT_FAILURES = 500;
export const REGISTRAR_WINDOW_SECONDS = 15 * 60;

/** The failure counters a sign-in to `username` from `ip` is checked against, with their limits. */
export function registrarCounters(username: string, ip: string | undefined): Array<[key: string, limit: number]> {
  const base = `state:portal-registrar-failures:${username}`;
  const client = clientOf(ip);

  return [
    [`${base}:client:${client.key}`, REGISTRAR_FAILURES],
    ...(client.network ? [[`${base}:net:${client.network}`, REGISTRAR_FAILURES * NETWORK_SHARES] as [string, number]] : []),
    [base, REGISTRAR_ACCOUNT_FAILURES]
  ];
}

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

  /** `ip`: req.ip, the address nginx passed on (counts a registrar's wrong passwords per client). */
  async login(username: string, password: string, ip: string | undefined) {
    const account = await this.prisma.demoPortalAccount.findUnique({ where: { username } });
    const counters = account?.role === 'registrar' ? registrarCounters(account.username, ip) : [];

    if (counters.length > 0) {
      const read = counters.reduce((m, [key]) => m.get(key).pttl(key), this.redis.multi());
      const replies = (await read.exec().catch(() => {
        throw unavailable();
      })) as Array<[null, string | number | null]>;
      const over = counters.findIndex(([, limit], i) => Number(replies[2 * i]![1]) >= limit);

      if (over >= 0) {
        const retryAfter = Math.max(1, Math.ceil(Number(replies[2 * over + 1]![1]) / 1000));

        throw apiError(429, 'RATE_LIMITED', 'Too many failed sign-ins for this account; try again later.', { retryAfter });
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
      if (counters.length > 0) {
        await counters
          .reduce((m, [key]) => m.incr(key).expire(key, REGISTRAR_WINDOW_SECONDS, 'NX'), this.redis.multi())
          .exec()
          .catch(() => undefined);
      }

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
