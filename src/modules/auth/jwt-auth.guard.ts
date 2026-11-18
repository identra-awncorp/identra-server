import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';

import { AuthService } from './auth.service';
import { AuthenticatedSession } from './auth.types';

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthenticatedSession;
}

/**
 * Requires `Authorization: Bearer <accessToken>`: verifies the JWT and that its device
 * session is still active (AuthService.authenticateAccessToken). Rejects with the same
 * 401 codes as the auth endpoints (ACCESS_TOKEN_REQUIRED, ACCESS_TOKEN_INVALID,
 * SESSION_REVOKED_OR_EXPIRED). Modules using it import AuthModule.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;

    req.auth = await this.authService.authenticateAccessToken(
      Array.isArray(header) ? header[0] : header
    );

    return true;
  }
}

/**
 * The caller authenticated by JwtAuthGuard: `@CurrentUser()` is the User,
 * `@CurrentUser('session')` the DeviceSession, `@CurrentUser('claims')` the token claims.
 */
export const CurrentUser = createParamDecorator(
  (key: keyof AuthenticatedSession | undefined, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth?.[key ?? 'user']
);
