import { BadRequestException } from '@nestjs/common';

export function normalizePhone(phone: string): string {
  const compact = phone.replace(/[^\d+]/g, '');

  if (!compact) {
    throw new BadRequestException('Phone number is required.');
  }

  if (compact.startsWith('+')) {
    const digits = compact.slice(1);

    if (!/^\d{8,15}$/.test(digits)) {
      throw new BadRequestException('Phone number must be E.164-compatible.');
    }

    return `+${digits}`;
  }

  if (compact.startsWith('00')) {
    const digits = compact.slice(2);

    if (!/^\d{8,15}$/.test(digits)) {
      throw new BadRequestException('Phone number must be E.164-compatible.');
    }

    return `+${digits}`;
  }

  if (compact.startsWith('84')) {
    return `+${compact}`;
  }

  if (compact.startsWith('0')) {
    return `+84${compact.slice(1)}`;
  }

  if (/^\d{8,15}$/.test(compact)) {
    return `+${compact}`;
  }

  throw new BadRequestException('Phone number must be E.164-compatible.');
}

export function phoneLookupValues(phone: string): string[] {
  const normalized = normalizePhone(phone);
  const compact = phone.replace(/[^\d+]/g, '');
  const localVietnamPhone = normalized.startsWith('+84') ? `0${normalized.slice(3)}` : null;

  return [...new Set([normalized, compact, localVietnamPhone].filter(Boolean) as string[])];
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
