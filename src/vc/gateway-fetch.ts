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

/**
 * HttpFetch of the DID trust path (ADR-0020 §9), given ONLY to the CertNet DID resolver and trust
 * registry (and certnet:register). Reaches only URLs under `gatewayUrl` (anything else is refused
 * without opening a socket), enforces `timeoutMs` over the whole exchange and `maxBytes` while
 * reading, and never follows a redirect (a 3xx is returned as it is). `localUrl` (development and
 * tests): requests for the gateway origin go there instead; the URLs the SDK builds stay canonical.
 */
export function createGatewayFetch(options: { gatewayUrl: string; localUrl?: string }): HttpFetch {
  const base = options.gatewayUrl.replace(/\/$/, '');
  const origin = new URL(base).origin;

  return async (url, init = {}) => {
    if (!url.startsWith(`${base}/`)) throw new Error('only the configured CertNet gateway is reached');

    const target = options.localUrl === undefined ? url : options.localUrl + url.slice(origin.length);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(target, {
        method: init.method ?? 'GET',
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
