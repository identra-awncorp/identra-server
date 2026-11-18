// Explicit allow-list only. An empty value or `*` yields no allowed origins: with
// `credentials: true`, reflecting every origin would let any site call the API as the user.
export function parseCorsOrigins(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== '*');
}
