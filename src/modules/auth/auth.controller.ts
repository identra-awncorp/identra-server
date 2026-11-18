import { Body, Controller, Delete, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DeviceSession, User } from '@prisma/client';

import { AuthService } from './auth.service';
import { PasswordLoginDto, SetRegistrationPasswordDto } from './dto/password.dto';
import { LogoutDto, RefreshTokenDto } from './dto/refresh-token.dto';
import { StartAuthDto } from './dto/start-auth.dto';
import { VerifyAuthDto, VerifyRegisterDto } from './dto/verify-auth.dto';
import { CurrentUser, JwtAuthGuard } from './jwt-auth.guard';

interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('status')
  getStatus() {
    return this.authService.getStatus();
  }

  @Post('register/start')
  startRegistration(@Body() body: StartAuthDto, @Req() req: RequestLike) {
    return this.authService.startRegistration(body, getRequestMeta(req));
  }

  @Post('register/verify')
  verifyRegistration(@Body() body: VerifyRegisterDto, @Req() req: RequestLike) {
    return this.authService.verifyRegistration(body, getRequestMeta(req));
  }

  @Post('register/password')
  setRegistrationPassword(@Body() body: SetRegistrationPasswordDto, @Req() req: RequestLike) {
    return this.authService.setRegistrationPassword(body, getRequestMeta(req));
  }

  @Post('login/start')
  startLogin(@Body() body: PasswordLoginDto, @Req() req: RequestLike) {
    return this.authService.startLogin(body, getRequestMeta(req));
  }

  @Post('login/verify')
  verifyLogin(@Body() body: VerifyAuthDto, @Req() req: RequestLike) {
    return this.authService.verifyLogin(body, getRequestMeta(req));
  }

  @Post('token/refresh')
  refreshToken(@Body() body: RefreshTokenDto, @Req() req: RequestLike) {
    return this.authService.refreshToken(body, getRequestMeta(req));
  }

  // Not guarded: logout also works with only a refreshToken in the body.
  @Post('logout')
  logout(@Headers('authorization') authorization: string | undefined, @Body() body: LogoutDto) {
    return this.authService.logout(authorization, body.refreshToken);
  }

  @Post('logout-all')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  logoutAll(@CurrentUser() user: User) {
    return this.authService.logoutAll(user.id);
  }

  @Get('devices')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listDevices(@CurrentUser() user: User, @CurrentUser('session') session: DeviceSession) {
    return this.authService.listDevices(user.id, session.id);
  }

  @Delete('devices/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  revokeDevice(
    @CurrentUser() user: User,
    @CurrentUser('session') session: DeviceSession,
    @Param('id') id: string
  ) {
    return this.authService.revokeDevice(user.id, session.id, id);
  }
}

function getRequestMeta(req: RequestLike) {
  return {
    ipAddress: readClientIp(req),
    userAgent: readHeader(req, 'user-agent') ?? null
  };
}

// req.ip honours `trust proxy` (one hop, see configureApp); reading X-Forwarded-For
// directly would let any client choose the IP stored on its session.
function readClientIp(req: RequestLike): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function readHeader(req: RequestLike, name: string): string | undefined {
  const value = req.headers?.[name.toLowerCase()] ?? req.headers?.[name];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
