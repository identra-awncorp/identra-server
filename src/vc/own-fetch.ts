import type { HttpFetch } from '@identra/sdk-core';
import type { StatusListService, TrustListService } from '@identra/sdk-server';

const STATUS_PATH = /^\/issuers\/([a-z0-9]+(?:-[a-z0-9]+)*)\/status\/([1-9][0-9]{0,8})$/;

type FetchResponse = Awaited<ReturnType<HttpFetch>>;

function local(status: number, body: string, contentType: string): FetchResponse {
  const headers: Record<string, string> = { 'content-type': contentType };

  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => body };
}

/**
 * HttpFetch for the server's own verifier (docs/vc-api.md §7): every issuer of this deployment
 * is hosted here, so the trust list and status lists at this server's canonical URLs are
 * answered by calling the services directly (a revocation is visible on the very next check),
 * any other path of the own origin is 404, and every other URL is refused without opening a
 * socket. The SDK checker and registry turn the refusal into `unavailable`.
 */
export function createOwnFetch(options: {
  baseUrl: string;
  trustList: TrustListService;
  statusLists: StatusListService;
}): HttpFetch {
  const { baseUrl, trustList, statusLists } = options;

  return async (url) => {
    if (url !== baseUrl && !url.startsWith(`${baseUrl}/`)) {
      throw new Error('verification reads lists only from this server');
    }

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
