import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @IsString()
  @MinLength(32)
  refreshToken: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  deviceId: string;
}

export class LogoutDto {
  @IsOptional()
  @IsString()
  @MinLength(32)
  refreshToken?: string;
}
