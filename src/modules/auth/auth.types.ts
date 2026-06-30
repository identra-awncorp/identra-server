import { DeviceSession, User } from '@prisma/client';

export interface AuthRequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  phone: string | null;
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
