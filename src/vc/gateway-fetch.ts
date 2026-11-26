import type { HttpFetch } from '@identra/sdk-core';

/** Used when a caller passes none; the SDK's CertNet clients always pass 5000 ms and 65 536 bytes. */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 65_536;

/** The body as UTF-8, rejecting once more than `max` bytes arrived (the rest is never read). */
async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('the gateway answer is too large');
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  if (res.body) {
    const reader = res.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw new Error('the gateway answer is too large');
      }

      chunks.push(value);
    }
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** The only requests of the read-only fetch: GetDid and LookupIssuer (one path segment each, any query). */
const READ_PATH = /^\/v1\/(dids|trust-registry\/issuers)\/[^/]+$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * `url` when it reaches the gateway under its prefix, else null: it must already be in canonical
 * form (so `..`, `%2e%2e` and `\` that the URL parser would resolve are refused, not resolved),
 * have the gateway's origin and path prefix, and no dot segment or backslash in any encoding (a
 * proxy or gateway that decodes `%2F..%2F` or `%252e` once more would reach another path).
 */
function gatewayPath(url: string, origin: string, prefix: string): { path: string; search: string } | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.href !== url || parsed.origin !== origin || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '' || url.includes('\\')) return null;
  if (!parsed.pathname.startsWith(`${prefix}/`)) return null;

  let decoded = parsed.pathname;

  // Decoded until it no longer changes; encoded more than three times is refused (no gateway path is).
  for (let round = 0; ; round += 1) {
    let next: string;

    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }

    if (next === decoded) break;
    if (round === 3) return null;
    decoded = next;
  }

  if (decoded.includes('\\') || decoded.split('/').some((segment) => segment === '.' || segment === '..')) return null;

  return { path: parsed.pathname.slice(prefix.length), search: parsed.search };
}

/**
 * HttpFetch of the DID trust path (ADR-0020 §9), given ONLY to the CertNet DID resolver and trust
 * registry (and certnet:register). Reaches only URLs under `gatewayUrl` (anything else is refused
 * without opening a socket, see gatewayPath), enforces `timeoutMs` over the whole exchange and
 * `maxBytes` while reading, and never follows a redirect (a 3xx is returned as it is). Read-only
 * unless `write` (certnet:register only): then only `GET` of `/v1/dids/<did>` and
 * `/v1/trust-registry/issuers/<did>`. An `authorization` header never goes over plain http except to
 * loopback. `localUrl` (development and tests): requests for the gateway origin go there instead;
 * the URLs the SDK builds stay canonical.
 */
export function createGatewayFetch(options: { gatewayUrl: string; localUrl?: string; write?: boolean }): HttpFetch {
  const base = new URL(options.gatewayUrl.replace(/\/$/, ''));
  const prefix = base.pathname.replace(/\/$/, '');

  return async (url, init = {}) => {
    const target = gatewayPath(url, base.origin, prefix);
    const method = init.method ?? 'GET';

    if (target === null) throw new Error('only the configured CertNet gateway is reached');
    if (!options.write && (method !== 'GET' || !READ_PATH.test(target.path))) throw new Error('this CertNet gateway fetch only reads DIDs and trust records');

    const sent = new URL(options.localUrl === undefined ? url : options.localUrl + prefix + target.path + target.search);
    const headers = new Headers(init.headers);

    if (headers.has('authorization') && sent.protocol !== 'https:' && !LOOPBACK.has(sent.hostname)) {
      throw new Error('credentials are never sent to the CertNet gateway over plain http');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(sent, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {})
      });
      const text = await readCapped(res, init.maxBytes ?? DEFAULT_MAX_BYTES);

      return { status: res.status, headers: res.headers, text: async () => text };
    } finally {
      clearTimeout(timer);
    }
  };
}
