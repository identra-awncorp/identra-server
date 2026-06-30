import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DeviceSession, OtpChallenge, OtpPurpose, Prisma, User, UserPassword } from '@prisma/client';
import * as argon2 from 'argon2';

import { createServiceStatus } from '../../common/types/service-status';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuthenticatedSession, AuthRequestMeta, AccessTokenClaims, AuthTokens } from './auth.types';
import { addDays, addSeconds, normalizePhone, phoneLookupValues } from './auth.utils';
import { PasswordLoginDto, SetRegistrationPasswordDto } from './dto/password.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { StartAuthDto } from './dto/start-auth.dto';
import { VerifyAuthDto, VerifyRegisterDto } from './dto/verify-auth.dto';

type PrismaTransaction = Prisma.TransactionClient;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService
  ) {}

  getStatus() {
    return createServiceStatus({
      module: 'auth',
      status: 'ready',
      purpose: 'Phone/password login, OTP step-up, refresh tokens, and device sessions.',
      next: ['Replace demo OTP provider with SMS vendor', 'Add device-bound biometric challenge']
    });
  }

  async startRegistration(body: StartAuthDto, meta: AuthRequestMeta) {
    const phone = normalizePhone(body.phone);
    const existingUser = await this.findUserByPhone(body.phone);

    if (existingUser && (await this.findUserPassword(existingUser.id))) {
      throw new ConflictException({
        code: 'PHONE_ALREADY_REGISTERED',
        message: 'This phone number is already registered.'
      });
    }

    const challenge = await this.createOtpChallenge({
      phone,
      purpose: OtpPurpose.REGISTER,
      userId: existingUser?.id,
      device: body.device,
      meta
    });

    return {
      data: this.mapChallenge(challenge, 'register')
    };
  }

  async verifyRegistration(body: VerifyRegisterDto, meta: AuthRequestMeta) {
    const phone = normalizePhone(body.phone);
    const challenge = await this.verifyOtpChallenge({
      challengeId: body.challengeId,
      phone,
      purpose: OtpPurpose.REGISTER,
      otpCode: body.otpCode
    });

    const existingUser = await this.findUserByPhone(phone);

    if (existingUser && (await this.findUserPassword(existingUser.id))) {
      throw new ConflictException({
        code: 'PHONE_ALREADY_REGISTERED',
        message: 'This phone number is already registered.'
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const user = existingUser
        ? await tx.user.update({
            where: { id: existingUser.id },
            data: {
              fullName: body.fullName?.trim() || existingUser.fullName,
              phone,
              phoneVerifiedAt: now
            }
          })
        : await tx.user.create({
            data: {
              fullName: body.fullName?.trim() || 'Identra User',
              phone,
              phoneVerifiedAt: now,
              settings: {
                language: 'vi',
                theme: 'system',
                notificationsEnabled: true,
                biometricAppLockEnabled: true
              }
            }
          });
      const registrationToken = this.createOpaqueToken();
      const registrationTokenExpiresAt = addSeconds(
        now,
        this.config.getOrThrow<number>('AUTH_REGISTRATION_TOKEN_TTL_SECONDS')
      );

      await tx.otpChallenge.update({
        where: { id: challenge.id },
        data: {
          userId: user.id,
          consumedAt: now,
          passwordSetupTokenHash: this.hashRegistrationToken(registrationToken),
          passwordSetupExpiresAt: registrationTokenExpiresAt
        }
      });

      return {
        data: {
          user: this.mapAuthUser(user),
          registration: {
            registrationToken,
            registrationTokenExpiresAt: registrationTokenExpiresAt.toISOString(),
            nextAction: 'SET_PASSWORD'
          }
        }
      };
    });
  }

  async setRegistrationPassword(body: SetRegistrationPasswordDto, meta: AuthRequestMeta) {
    this.validatePassword(body.password);

    const tokenHash = this.hashRegistrationToken(body.registrationToken);
    const now = new Date();
    const challenge = await this.prisma.otpChallenge.findUnique({
      where: { passwordSetupTokenHash: tokenHash },
      include: { user: true }
    });

    if (
      !challenge ||
      !challenge.user ||
      challenge.purpose !== OtpPurpose.REGISTER ||
      !challenge.consumedAt ||
      challenge.passwordSetAt ||
      !challenge.passwordSetupExpiresAt ||
      challenge.passwordSetupExpiresAt <= now
    ) {
      throw new UnauthorizedException({
        code: 'REGISTRATION_TOKEN_INVALID',
        message: 'Registration token is invalid or expired.'
      });
    }

    const registrationUser = challenge.user;
    const existingPassword = await this.findUserPassword(registrationUser.id);

    if (existingPassword) {
      throw new ConflictException({
        code: 'PASSWORD_ALREADY_SET',
        message: 'Password has already been set for this account.'
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.userPassword.create({
        data: {
          userId: registrationUser.id,
          passwordHash: await this.hashPassword(body.password),
          passwordPepperVersion: this.config.getOrThrow<string>('PASSWORD_PEPPER_VERSION')
        }
      });

      await tx.otpChallenge.update({
        where: { id: challenge.id },
        data: {
          passwordSetAt: now,
          passwordSetupTokenHash: null
        }
      });

      return this.createAuthResponse(tx, registrationUser, body.device, meta, now);
    });
  }

  async startLogin(body: PasswordLoginDto, meta: AuthRequestMeta) {
    const phone = normalizePhone(body.phone);
    const user = await this.findUserByPhone(phone);

    if (!user) {
      throw new NotFoundException({
        code: 'PHONE_NOT_REGISTERED',
        message: 'This phone number is not registered.'
      });
    }

    const userPassword = await this.findUserPassword(user.id);

    if (!userPassword) {
      throw new ForbiddenException({
        code: 'PASSWORD_NOT_SET',
        message: 'This account has not completed password setup.'
      });
    }

    await this.verifyPasswordOrThrow(userPassword, body.password);

    const deviceKnown = await this.hasTrustedDevice(user.id, body.device.deviceId);

    if (deviceKnown) {
      return this.prisma.$transaction((tx) =>
        this.createAuthResponse(tx, user, body.device, meta, new Date())
      );
    }

    const challenge = await this.createOtpChallenge({
      phone,
      purpose: OtpPurpose.LOGIN,
      userId: user.id,
      device: body.device,
      meta
    });

    return {
      data: {
        ...this.mapChallenge(challenge, 'login'),
        deviceKnown,
        requiresOtp: true
      }
    };
  }

  async verifyLogin(body: VerifyAuthDto, meta: AuthRequestMeta) {
    const phone = normalizePhone(body.phone);
    const challenge = await this.verifyOtpChallenge({
      challengeId: body.challengeId,
      phone,
      purpose: OtpPurpose.LOGIN,
      otpCode: body.otpCode
    });
    const user = challenge.userId
      ? await this.prisma.user.findUnique({ where: { id: challenge.userId } })
      : await this.findUserByPhone(phone);

    if (!user) {
      throw new NotFoundException({
        code: 'PHONE_NOT_REGISTERED',
        message: 'This phone number is not registered.'
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      await tx.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: now }
      });

      return this.createAuthResponse(tx, user, body.device, meta, now);
    });
  }

  async refreshToken(body: RefreshTokenDto, meta: AuthRequestMeta) {
    const refreshTokenHash = this.hashRefreshToken(body.refreshToken);
    const now = new Date();
    const session = await this.prisma.deviceSession.findUnique({
      where: { refreshTokenHash },
      include: { user: true }
    });

    if (!session || session.revokedAt || session.expiresAt <= now) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token is invalid or expired.'
      });
    }

    if (session.deviceId !== body.deviceId) {
      await this.prisma.deviceSession.update({
        where: { id: session.id },
        data: { revokedAt: now }
      });

      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_DEVICE_MISMATCH',
        message: 'Refresh token does not belong to this device.'
      });
    }

    const refreshToken = this.createOpaqueToken();
    const refreshTokenExpiresAt = addDays(now, this.config.getOrThrow<number>('JWT_REFRESH_TTL_DAYS'));
    const updatedSession = await this.prisma.deviceSession.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: this.hashRefreshToken(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        lastSeenAt: now,
        rotatedAt: now,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent
      }
    });
    const tokens = await this.createTokens(session.user, updatedSession, refreshToken);

    return {
      data: {
        user: this.mapAuthUser(session.user),
        session: this.mapSession(updatedSession),
        tokens
      }
    };
  }

  async logout(authorization: string | undefined, refreshToken: string | undefined) {
    const now = new Date();
    const sessionIds = new Set<string>();

    if (authorization) {
      const auth = await this.authenticateAccessToken(authorization);
      sessionIds.add(auth.session.id);
    }

    if (refreshToken) {
      const refreshTokenHash = this.hashRefreshToken(refreshToken);
      const session = await this.prisma.deviceSession.findUnique({ where: { refreshTokenHash } });

      if (session) {
        sessionIds.add(session.id);
      }
    }

    if (sessionIds.size === 0) {
      throw new BadRequestException({
        code: 'LOGOUT_TOKEN_REQUIRED',
        message: 'Authorization bearer token or refreshToken is required.'
      });
    }

    await this.prisma.deviceSession.updateMany({
      where: {
        id: {
          in: [...sessionIds]
        }
      },
      data: {
        revokedAt: now,
        refreshTokenHash: null
      }
    });

    return {
      data: {
        revokedSessions: sessionIds.size
      }
    };
  }

  async logoutAll(authorization: string | undefined) {
    const auth = await this.authenticateAccessToken(authorization);
    const now = new Date();
    const result = await this.prisma.deviceSession.updateMany({
      where: {
        userId: auth.user.id,
        revokedAt: null
      },
      data: {
        revokedAt: now,
        refreshTokenHash: null
      }
    });

    return {
      data: {
        revokedSessions: result.count
      }
    };
  }

  async listDevices(authorization: string | undefined) {
    const auth = await this.authenticateAccessToken(authorization);
    const sessions = await this.prisma.deviceSession.findMany({
      where: { userId: auth.user.id },
      orderBy: { updatedAt: 'desc' }
    });

    return {
      data: sessions.map((session) => ({
        ...this.mapSession(session),
        current: session.id === auth.session.id
      }))
    };
  }

  async revokeDevice(authorization: string | undefined, id: string) {
    const auth = await this.authenticateAccessToken(authorization);
    const session = await this.prisma.deviceSession.findFirst({
      where: {
        id,
        userId: auth.user.id
      }
    });

    if (!session) {
      throw new NotFoundException({
        code: 'DEVICE_SESSION_NOT_FOUND',
        message: 'Device session was not found.'
      });
    }

    if (session.id === auth.session.id) {
      throw new ForbiddenException({
        code: 'CANNOT_REVOKE_CURRENT_DEVICE_HERE',
        message: 'Use /auth/logout to revoke the current device.'
      });
    }

    await this.prisma.deviceSession.update({
      where: { id: session.id },
      data: {
        revokedAt: new Date(),
        trustRevokedAt: new Date(),
        refreshTokenHash: null
      }
    });

    return {
      data: {
        revoked: true
      }
    };
  }

  private async createOtpChallenge(input: {
    phone: string;
    purpose: OtpPurpose;
    userId?: string;
    device: StartAuthDto['device'];
    meta: AuthRequestMeta;
  }) {
    const now = new Date();
    const windowStart = addSeconds(now, -60 * 60);
    const startsInWindow = await this.prisma.otpChallenge.count({
      where: {
        phone: input.phone,
        purpose: input.purpose,
        createdAt: {
          gte: windowStart
        }
      }
    });

    if (startsInWindow >= this.config.getOrThrow<number>('OTP_MAX_STARTS_PER_HOUR')) {
      throw new HttpException(
        {
          code: 'OTP_RATE_LIMITED',
          message: 'Too many OTP requests. Please try again later.'
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    const cooldownSeconds = this.config.getOrThrow<number>('OTP_RESEND_COOLDOWN_SECONDS');
    const latestChallenge = await this.prisma.otpChallenge.findFirst({
      where: {
        phone: input.phone,
        purpose: input.purpose,
        consumedAt: null
      },
      orderBy: { createdAt: 'desc' }
    });

    if (latestChallenge && latestChallenge.resendAvailableAt > now) {
      throw new HttpException(
        {
          code: 'OTP_RESEND_COOLDOWN',
          message: 'Please wait before requesting another OTP.',
          resendAvailableAt: latestChallenge.resendAvailableAt.toISOString()
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    const expiresAt = addSeconds(now, this.config.getOrThrow<number>('OTP_TTL_SECONDS'));
    const code = this.config.getOrThrow<string>('OTP_DEMO_CODE');

    return this.prisma.otpChallenge.create({
      data: {
        phone: input.phone,
        userId: input.userId,
        purpose: input.purpose,
        codeHash: this.hashOtpCode(input.phone, input.purpose, code, expiresAt),
        expiresAt,
        maxAttempts: this.config.getOrThrow<number>('OTP_MAX_ATTEMPTS'),
        resendAvailableAt: addSeconds(now, cooldownSeconds),
        deviceId: input.device.deviceId,
        platform: input.device.platform,
        deviceName: input.device.deviceName,
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent
      }
    });
  }

  private async verifyOtpChallenge(input: {
    challengeId: string;
    phone: string;
    purpose: OtpPurpose;
    otpCode: string;
  }): Promise<OtpChallenge> {
    const challenge = await this.prisma.otpChallenge.findUnique({
      where: { id: input.challengeId }
    });
    const now = new Date();

    if (!challenge || challenge.phone !== input.phone || challenge.purpose !== input.purpose) {
      throw new NotFoundException({
        code: 'OTP_CHALLENGE_NOT_FOUND',
        message: 'OTP challenge was not found.'
      });
    }

    if (challenge.consumedAt) {
      throw new GoneException({
        code: 'OTP_ALREADY_CONSUMED',
        message: 'OTP challenge has already been consumed.'
      });
    }

    if (challenge.expiresAt <= now) {
      throw new GoneException({
        code: 'OTP_EXPIRED',
        message: 'OTP challenge has expired.'
      });
    }

    if (challenge.failedAttempts >= challenge.maxAttempts) {
      throw new HttpException(
        {
          code: 'OTP_ATTEMPTS_EXCEEDED',
          message: 'OTP challenge has too many failed attempts.'
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    const expectedHash = this.hashOtpCode(
      challenge.phone,
      challenge.purpose,
      input.otpCode,
      challenge.expiresAt
    );

    if (!safeEqual(challenge.codeHash, expectedHash)) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: {
          failedAttempts: {
            increment: 1
          }
        }
      });

      throw new UnauthorizedException({
        code: 'OTP_INVALID',
        message: 'OTP code is invalid.',
        remainingAttempts: Math.max(challenge.maxAttempts - challenge.failedAttempts - 1, 0)
      });
    }

    return challenge;
  }

  private async createAuthResponse(
    tx: PrismaTransaction,
    user: User,
    device: StartAuthDto['device'],
    meta: AuthRequestMeta,
    now: Date
  ) {
    const refreshToken = this.createOpaqueToken();
    const refreshTokenExpiresAt = addDays(now, this.config.getOrThrow<number>('JWT_REFRESH_TTL_DAYS'));
    const session = await tx.deviceSession.upsert({
      where: {
        userId_deviceId: {
          userId: user.id,
          deviceId: device.deviceId
        }
      },
      create: {
        userId: user.id,
        deviceId: device.deviceId,
        platform: device.platform,
        deviceName: device.deviceName,
        appVersion: device.appVersion,
        refreshTokenHash: this.hashRefreshToken(refreshToken),
        trustedAt: now,
        trustRevokedAt: null,
        lastSeenAt: now,
        rotatedAt: now,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt: refreshTokenExpiresAt
      },
      update: {
        platform: device.platform,
        deviceName: device.deviceName,
        appVersion: device.appVersion,
        refreshTokenHash: this.hashRefreshToken(refreshToken),
        trustedAt: now,
        trustRevokedAt: null,
        lastSeenAt: now,
        rotatedAt: now,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt: refreshTokenExpiresAt,
        revokedAt: null
      }
    });
    const tokens = await this.createTokens(user, session, refreshToken);

    return {
      data: {
        user: this.mapAuthUser(user),
        session: this.mapSession(session),
        tokens
      }
    };
  }

  private async authenticateAccessToken(
    authorization: string | undefined
  ): Promise<AuthenticatedSession> {
    const token = readBearerToken(authorization);

    if (!token) {
      throw new UnauthorizedException({
        code: 'ACCESS_TOKEN_REQUIRED',
        message: 'Bearer access token is required.'
      });
    }

    let claims: AccessTokenClaims;

    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET')
      });
    } catch {
      throw new UnauthorizedException({
        code: 'ACCESS_TOKEN_INVALID',
        message: 'Bearer access token is invalid or expired.'
      });
    }

    const session = await this.prisma.deviceSession.findFirst({
      where: {
        id: claims.sid,
        userId: claims.sub,
        revokedAt: null,
        expiresAt: {
          gt: new Date()
        }
      },
      include: { user: true }
    });

    if (!session) {
      throw new UnauthorizedException({
        code: 'SESSION_REVOKED_OR_EXPIRED',
        message: 'Device session is revoked or expired.'
      });
    }

    return {
      claims,
      user: session.user,
      session
    };
  }

  private async createTokens(
    user: User,
    session: DeviceSession,
    refreshToken: string
  ): Promise<AuthTokens> {
    const expiresInSeconds = this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        sid: session.id,
        phone: user.phone,
        role: 'user',
        scopes: ['user']
      } satisfies AccessTokenClaims,
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: expiresInSeconds
      }
    );

    return {
      tokenType: 'Bearer',
      accessToken,
      accessTokenExpiresAt: addSeconds(new Date(), expiresInSeconds).toISOString(),
      expiresInSeconds,
      refreshToken,
      refreshTokenExpiresAt: session.expiresAt.toISOString()
    };
  }

  private async findUserByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        phone: {
          in: phoneLookupValues(phone)
        }
      }
    });
  }

  private async findUserPassword(userId: string): Promise<UserPassword | null> {
    return this.prisma.userPassword.findUnique({
      where: { userId }
    });
  }

  private async verifyPasswordOrThrow(userPassword: UserPassword, password: string): Promise<void> {
    const now = new Date();

    if (userPassword.lockedUntil && userPassword.lockedUntil > now) {
      throw new HttpException(
        {
          code: 'PASSWORD_LOCKED',
          message: 'Password login is temporarily locked.',
          lockedUntil: userPassword.lockedUntil.toISOString()
        },
        HttpStatus.LOCKED
      );
    }

    const valid = await argon2.verify(userPassword.passwordHash, this.withPasswordPepper(password));

    if (!valid) {
      const failedAttempts = userPassword.failedAttempts + 1;
      const maxAttempts = this.config.getOrThrow<number>('PASSWORD_MAX_FAILED_ATTEMPTS');
      const lockedUntil =
        failedAttempts >= maxAttempts
          ? addSeconds(now, this.config.getOrThrow<number>('PASSWORD_LOCK_SECONDS'))
          : null;

      await this.prisma.userPassword.update({
        where: { id: userPassword.id },
        data: {
          failedAttempts,
          lockedUntil
        }
      });

      throw new UnauthorizedException({
        code: 'PASSWORD_INVALID',
        message: 'Password is invalid.',
        remainingAttempts: Math.max(maxAttempts - failedAttempts, 0),
        lockedUntil: lockedUntil?.toISOString() ?? null
      });
    }

    if (userPassword.failedAttempts > 0 || userPassword.lockedUntil) {
      await this.prisma.userPassword.update({
        where: { id: userPassword.id },
        data: {
          failedAttempts: 0,
          lockedUntil: null
        }
      });
    }
  }

  private validatePassword(password: string): void {
    const minLength = this.config.getOrThrow<number>('PASSWORD_MIN_LENGTH');
    const maxLength = this.config.getOrThrow<number>('PASSWORD_MAX_LENGTH');
    const length = Array.from(password).length;

    if (length < minLength || length > maxLength) {
      throw new BadRequestException({
        code: 'PASSWORD_LENGTH_INVALID',
        message: `Password must be between ${minLength} and ${maxLength} characters.`,
        minLength,
        maxLength
      });
    }

    if (password !== password.trim()) {
      throw new BadRequestException({
        code: 'PASSWORD_EDGE_WHITESPACE',
        message: 'Password must not start or end with whitespace.'
      });
    }

    if (!/^[\x20-\x7E]+$/.test(password)) {
      throw new BadRequestException({
        code: 'PASSWORD_UNSUPPORTED_CHARACTER',
        message: 'Password must contain only printable ASCII characters.'
      });
    }
  }

  private async hashPassword(password: string): Promise<string> {
    return argon2.hash(this.withPasswordPepper(password), {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1
    });
  }

  private withPasswordPepper(password: string): string {
    return `${password}${this.config.getOrThrow<string>('PASSWORD_PEPPER')}`;
  }

  private async hasTrustedDevice(userId: string, deviceId: string): Promise<boolean> {
    const session = await this.prisma.deviceSession.findFirst({
      where: {
        userId,
        deviceId,
        trustedAt: {
          not: null
        },
        trustRevokedAt: null
      },
      select: { id: true }
    });

    return Boolean(session);
  }

  private mapChallenge(challenge: OtpChallenge, purpose: 'register' | 'login') {
    return {
      challengeId: challenge.id,
      purpose,
      phone: challenge.phone,
      expiresAt: challenge.expiresAt.toISOString(),
      resendAvailableAt: challenge.resendAvailableAt.toISOString(),
      maxAttempts: challenge.maxAttempts,
      delivery: {
        channel: 'sms',
        provider: 'demo',
        to: challenge.phone,
        demoOtp: this.config.getOrThrow<string>('OTP_DEMO_CODE')
      }
    };
  }

  private mapAuthUser(user: User) {
    return {
      id: user.id,
      phone: user.phone,
      phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
      fullName: user.fullName
    };
  }

  private mapSession(session: DeviceSession) {
    return {
      id: session.id,
      deviceId: session.deviceId,
      platform: session.platform,
      deviceName: session.deviceName,
      appVersion: session.appVersion,
      trustedAt: session.trustedAt?.toISOString() ?? null,
      trustRevokedAt: session.trustRevokedAt?.toISOString() ?? null,
      lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
      expiresAt: session.expiresAt.toISOString(),
      revokedAt: session.revokedAt?.toISOString() ?? null
    };
  }

  private hashOtpCode(phone: string, purpose: OtpPurpose, code: string, expiresAt: Date): string {
    return createHmac('sha256', this.config.getOrThrow<string>('OTP_HMAC_SECRET'))
      .update([phone, purpose, code, expiresAt.toISOString()].join(':'))
      .digest('hex');
  }

  private hashRefreshToken(refreshToken: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_REFRESH_SECRET'))
      .update(refreshToken)
      .digest('hex');
  }

  private hashRegistrationToken(registrationToken: string): string {
    return createHmac(
      'sha256',
      this.config.getOrThrow<string>('AUTH_REGISTRATION_TOKEN_SECRET')
    )
      .update(registrationToken)
      .digest('hex');
  }

  private createOpaqueToken(): string {
    return randomBytes(48).toString('base64url');
  }
}

function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
