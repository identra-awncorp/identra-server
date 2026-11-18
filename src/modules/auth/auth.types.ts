import { DeviceSession, User } from '@prisma/client';

export interface AuthRequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

// No personal data here: bearer tokens pass through proxies and client logs (ADR-0014 §4).
export interface AccessTokenClaims {
  sub: string;
  sid: string;
  /** DeviceSession.loginId: binds the token to one login, so a re-login revokes older tokens. */
  lid: string;
  token_use: 'access';
  role: 'user';
  scopes: string[];
  iat?: number;
  exp?: number;
}

export interface AuthenticatedSession {
  claims: AccessTokenClaims;
  user: User;
  session: DeviceSession;
}

export interface AuthTokens {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresAt: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}
