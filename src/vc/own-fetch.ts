import type { HttpFetch, StatusListService, TrustListService } from '../sdk.mjs';

const NETWORK_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const STATUS_PATH = /^\/issuers\/([a-z0-9]+(?:-[a-z0-9]+)*)\/status\/([1-9][0-9]{0,8})$/;

type FetchResponse = Awaited<ReturnType<HttpFetch>>;

function local(status: number, body: string, contentType: string): FetchResponse {
  const headers: Record<string, string> = { 'content-type': contentType };

  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => body };
}

/** Reads at most MAX_RESPONSE_BYTES, then gives up (HttpFetch contract: sdk-core reads text() whole). */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');

  if (declared > MAX_RESPONSE_BYTES || !res.body) {
    await res.body?.cancel();

    if (declared > MAX_RESPONSE_BYTES) throw new Error('response too large');

    return '';
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    size += value.byteLength;

    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('response too large');
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function networkFetch(url: string, init: Parameters<HttpFetch>[1] = {}): Promise<FetchResponse> {
  if (!url.startsWith('https://')) throw new TypeError('only https URLs are fetched');

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    redirect: 'error',
    signal: AbortSignal.timeout(Math.min(init.timeoutMs ?? NETWORK_TIMEOUT_MS, NETWORK_TIMEOUT_MS))
  });
  const body = await readCapped(res);

  return { status: res.status, headers: res.headers, text: async () => body };
}

/**
 * HttpFetch for the server's own verifier: the trust list and status lists at this server's
 * canonical URLs are answered by calling the services directly (no network, so a revocation is
 * visible on the very next check); any other path of the own origin is 404 without leaving the
 * process. Everything else goes to the network: https only, no redirects, 5 s, 256 KB.
 */
export function createOwnFetch(options: {
  baseUrl: string;
  trustList: TrustListService;
  statusLists: StatusListService;
}): HttpFetch {
  const { baseUrl, trustList, statusLists } = options;

  return async (url, init) => {
    if (url !== baseUrl && !url.startsWith(`${baseUrl}/`)) return networkFetch(url, init);

    const path = url.slice(baseUrl.length);

    try {
      if (path === '/trust-list') return local(200, await trustList.token(), 'application/jwt');

      const status = STATUS_PATH.exec(path);

      if (status) {
        const token = await statusLists.token(status[1]!, Number(status[2]));

        return token === null ? local(404, '', 'text/plain') : local(200, token, 'application/statuslist+jwt');
      }
    } catch {
      return local(503, '', 'text/plain');
    }

    return local(404, '', 'text/plain');
  };
}
