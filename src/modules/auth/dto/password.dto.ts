import { Type } from 'class-transformer';
import { IsDefined, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

import { AuthDeviceDto } from './auth-device.dto';

export class PasswordLoginDto {
  @IsString()
  @MinLength(8)
  @MaxLength(24)
  phone: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AuthDeviceDto)
  device: AuthDeviceDto;
}

export class SetRegistrationPasswordDto {
  @IsString()
  @MinLength(32)
  registrationToken: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AuthDeviceDto)
  device: AuthDeviceDto;
}
