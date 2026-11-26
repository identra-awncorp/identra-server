// A small stand-in for the CertNet gateway, shaped like the contract (docs/certnet/spec-2026-11-25,
// 4-openapi.yaml): GET/POST /v1/dids, GET/POST /v1/trust-registry/issuers, POST …/reject. Tests
// only; it is not CertNet and implements nothing beyond what these tests need.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** The canonical gateway origin of the tests (identifiers stay canonical; network goes to the stub). */
export const GATEWAY = 'https://gateway.certnet.example';
export const NETWORK = 'local';

type Json = Record<string, unknown>;

export interface StubGateway {
  url: string;
  dids: Map<string, Json>;
  trust: Map<string, Json>;
  /** `unavailable`: every request 503; `reset`: the connection is dropped; `trust-unavailable`: trust lookups 503. */
  mode: 'ok' | 'unavailable' | 'reset' | 'trust-unavailable';
  /** Rewrites the next CreateDid answer (tests of certnet:register). */
  tamper?: (answer: Json) => Json;
  /** Status of the next POST /v1/dids instead of creating one. */
  createStatus?: number;
  requests: Array<{ method: string; path: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

const error = (code: string, message: string) => ({ code, message });

export async function startStubGateway(port: number): Promise<StubGateway> {
  const stub: StubGateway = {
    url: `http://127.0.0.1:${port}`,
    dids: new Map(),
    trust: new Map(),
    mode: 'ok',
    requests: [],
    close: async () => undefined
  };

  function answer(method: string, path: string, body: Json | null): [number, unknown] {
    const parts = path.split('?')[0]!.split('/').map((p) => decodeURIComponent(p));

    if (method === 'GET' && parts.length === 4 && parts[2] === 'dids') {
      const document = stub.dids.get(parts[3]!);

      return document ? [200, { did: parts[3], document }] : [404, error('DID_NOT_FOUND', 'DID not found')];
    }

    if (method === 'POST' && path === '/v1/dids') {
      if (stub.createStatus !== undefined) return [stub.createStatus, error('UNAUTHORIZED', 'refused by the test')];

      const vm = (body?.verificationMethods as Json[] | undefined)?.[0];

      if (!vm || typeof vm.idFragment !== 'string') return [422, error('DID_INVALID', 'verificationMethods[0] is required')];

      const did = `did:certnet:${String(body?.network ?? NETWORK)}:${randomBytes(8).toString('hex')}`;
      const kid = `${did}#${vm.idFragment}`;
      const document = {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: did,
        verificationMethod: [{ id: kid, type: 'JsonWebKey2020', controller: did, publicKeyJwk: vm.publicKeyJwk }],
        authentication: [kid],
        assertionMethod: [kid]
      };
      const created = { did, document };

      stub.dids.set(did, document);

      return [201, stub.tamper ? stub.tamper(created) : created];
    }

    if (parts[2] === 'trust-registry' && parts[3] === 'issuers') {
      if (method === 'POST' && parts.length === 4) {
        const issuerDid = String(body?.issuerDid ?? '');

        if (!issuerDid.startsWith('did:certnet:')) return [422, error('DID_INVALID', 'issuerDid must be a did:certnet DID')];
        if (stub.trust.has(issuerDid)) return [409, error('INTERNAL_ERROR', 'issuer already registered')];

        const record = { issuerDid, recognition: 'recognized', scopes: body?.scopes ?? [], vcTypes: body?.vcTypes ?? [], accreditingBody: null };

        stub.trust.set(issuerDid, record);

        return [201, record];
      }

      const record = stub.trust.get(parts[4] ?? '');

      if (!record) return [404, error('ISSUER_NOT_FOUND', 'issuer not in the trust registry')];
      if (method === 'GET' && parts.length === 5) return stub.mode === 'trust-unavailable' ? [503, error('CHAIN_UNAVAILABLE', 'chain down')] : [200, record];
      if (method === 'POST' && parts.length === 6 && parts[5] === 'reject') return [200, Object.assign(record, { recognition: 'rejected' })];
    }

    return [404, error('INTERNAL_ERROR', 'not part of this stub')];
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];

    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '/';

      stub.requests.push({ method: req.method ?? '', path, authorization: req.headers.authorization });

      if (stub.mode === 'reset') return void req.socket.destroy();

      let body: Json | null = null;

      try {
        body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json) : null;
      } catch {
        body = null;
      }

      const [status, out] = stub.mode === 'unavailable' ? [503, error('CHAIN_UNAVAILABLE', 'chain down')] : answer(req.method ?? '', path, body);

      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  stub.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  server.unref();

  return stub;
}
