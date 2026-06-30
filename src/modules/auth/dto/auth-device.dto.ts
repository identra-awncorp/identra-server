import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AuthDeviceDto {
  @IsString()
  @MinLength(6)
  @MaxLength(128)
  deviceId: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  appVersion?: string;
}
