import { Type } from 'class-transformer';
import { IsDefined, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

import { AuthDeviceDto } from './auth-device.dto';

export class StartAuthDto {
  @IsString()
  @MinLength(8)
  @MaxLength(24)
  phone: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AuthDeviceDto)
  device: AuthDeviceDto;
}
