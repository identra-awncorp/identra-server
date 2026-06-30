import { Type } from 'class-transformer';
import {
  IsDefined,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested
} from 'class-validator';

import { AuthDeviceDto } from './auth-device.dto';

export class VerifyAuthDto {
  @IsString()
  challengeId: string;

  @IsString()
  @MinLength(8)
  @MaxLength(24)
  phone: string;

  @IsString()
  @Matches(/^\d{6}$/)
  otpCode: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AuthDeviceDto)
  device: AuthDeviceDto;
}

export class VerifyRegisterDto extends VerifyAuthDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  fullName?: string;
}
