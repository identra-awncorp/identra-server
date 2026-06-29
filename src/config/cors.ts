export function parseCorsOrigins(value?: string): string[] | boolean {
  if (!value || value.trim() === '*') return true;

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
