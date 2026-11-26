// The HttpFetch of the DID trust path (src/vc/gateway-fetch.ts, ADR-0020 §9): only the configured
// gateway, the size cap while reading, the timeout over the whole exchange, no redirect followed.
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createGatewayFetch } from '../src/vc/gateway-fetch';

const PORT = 47451;
const LOCAL = `http://127.0.0.1:${PORT}`;
const GATEWAY = 'https://gateway.certnet.example/certnet';
const seen: string[] = [];
let connections = 0;

/** Paths name the behaviour: /certnet/v1/<what>. */
const server = createServer((req, res: ServerResponse) => {
  seen.push(req.url ?? '');

  switch (req.url) {
    case '/certnet/v1/ok':
      return void res.end('{"ok":true}');
    case '/certnet/v1/exact':
      return void res.end('x'.repeat(1000));
    case '/certnet/v1/big-declared':
      res.writeHead(200, { 'content-length': '1001' });
      return void res.end('x'.repeat(1001));
    case '/certnet/v1/big-streamed':
      // No Content-Length: the cap must stop the read, not wait for the end.
      res.writeHead(200);
      res.write('x'.repeat(800));
      return void setTimeout(() => res.write('x'.repeat(800)), 20);
    case '/certnet/v1/slow-body':
      res.writeHead(200);
      return void res.write('{"partial":');
    case '/certnet/v1/redirect':
      res.writeHead(302, { location: '/certnet/v1/ok' });
      return void res.end();
    default:
      res.writeHead(404);
      return void res.end();
  }
});

server.on('connection', () => (connections += 1));

before(() => new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve)));
after(() => {
  server.closeAllConnections();
  server.close();
});

// The transport tests below use the write-enabled instance (certnet:register's), which reaches any
// path under the gateway; the server's own instance is read-only (last describe).
const gatewayFetch = createGatewayFetch({ gatewayUrl: GATEWAY, localUrl: LOCAL, write: true });
const readOnlyFetch = createGatewayFetch({ gatewayUrl: GATEWAY, localUrl: LOCAL });

describe('the gateway fetch', () => {
  it('reaches the configured gateway (mapped to the local listener) and returns the answer', async () => {
    const res = await gatewayFetch(`${GATEWAY}/v1/ok`, { timeoutMs: 1000, maxBytes: 100 });

    assert.deepEqual([res.status, await res.text()], [200, '{"ok":true}']);
    assert.equal(seen.at(-1), '/certnet/v1/ok');
  });

  it('refuses every other URL without opening a socket', async () => {
    const before = connections;

    for (const url of [
      'https://gateway.certnet.example/other/v1/ok',
      'https://gateway.certnet.example/certnetx/v1/ok',
      'https://gateway.certnet.example/certnet',
      'https://gateway.certnet.example.evil.example/certnet/v1/ok',
      'https://evil.example/certnet/v1/ok',
      'http://gateway.certnet.example/certnet/v1/ok',
      `${LOCAL}/certnet/v1/ok`,
      'https://api-identra.awncorp.vn/issuers/truong-mau/status/1'
    ]) {
      await assert.rejects(gatewayFetch(url), /only the configured CertNet gateway/, url);
    }

    assert.equal(connections, before);
  });

  it('enforces maxBytes: an exact fit passes; declared or streamed beyond it is refused while reading', async () => {
    assert.equal((await (await gatewayFetch(`${GATEWAY}/v1/exact`, { maxBytes: 1000 })).text()).length, 1000);
    await assert.rejects(gatewayFetch(`${GATEWAY}/v1/big-declared`, { maxBytes: 1000 }), /too large/);

    const started = Date.now();

    await assert.rejects(gatewayFetch(`${GATEWAY}/v1/big-streamed`, { maxBytes: 1000, timeoutMs: 5000 }), /too large/);
    assert.ok(Date.now() - started < 1000, 'stopped at the cap, not at the timeout');
  });

  it('enforces timeoutMs over the body as well', async () => {
    const started = Date.now();

    await assert.rejects(gatewayFetch(`${GATEWAY}/v1/slow-body`, { timeoutMs: 200 }));
    assert.ok(Date.now() - started < 2000);
  });

  it('never follows a redirect: the 3xx is returned as it is', async () => {
    const count = seen.length;
    const res = await gatewayFetch(`${GATEWAY}/v1/redirect`);

    assert.equal(res.status, 302);
    assert.deepEqual(seen.slice(count), ['/certnet/v1/redirect']);
  });
});

describe('the gateway fetch: what reaches the gateway', () => {
  const did = encodeURIComponent('did:certnet:local:abc123');

  it('refuses dot segments and backslashes in any encoding, URLs not in canonical form and credentials, without opening a socket', async () => {
    const before = connections;

    for (const url of [
      `${GATEWAY}/../admin`,
      `${GATEWAY}/%2e%2e/admin`,
      `${GATEWAY}/.%2E/admin`,
      `${GATEWAY}/..\\admin`,
      `${GATEWAY}/v1/./ok`,
      `${GATEWAY}/v1/dids/x%2F..%2F..%2F..%2Fadmin`,
      `${GATEWAY}/v1/dids/%252e%252e`,
      `${GATEWAY}/v1/dids/%25252e%25252e`,
      `${GATEWAY}/v1/dids/%2525252e`,
      `${GATEWAY}/v1/dids/a%5Cb`,
      `${GATEWAY}/v1/dids/a%255Cb`,
      `${GATEWAY}/v1/dids/%E0%A4%A`,
      `${GATEWAY}/v1/dids/${did}?q=a\\b`,
      'https://GATEWAY.certnet.example/certnet/v1/ok',
      'https://gateway.certnet.example:443/certnet/v1/ok',
      'https://u:p@gateway.certnet.example/certnet/v1/ok',
      'https://gateway.certnet.example/certnet/v1/ok#f'
    ]) {
      await assert.rejects(gatewayFetch(url, { timeoutMs: 500 }), /only the configured CertNet gateway/, url);
      await assert.rejects(readOnlyFetch(url, { timeoutMs: 500 }), /only the configured CertNet gateway/, url);
    }

    assert.equal(connections, before);
  });

  it('the read-only instance (the server\'s) sends only GET of /v1/dids/<did> and /v1/trust-registry/issuers/<did>', async () => {
    const before = connections;
    const count = seen.length;

    for (const [url, method] of [
      [`${GATEWAY}/v1/dids`, 'POST'],
      [`${GATEWAY}/v1/dids/${did}`, 'POST'],
      [`${GATEWAY}/v1/dids/${did}/deactivate`, 'POST'],
      [`${GATEWAY}/v1/dids/${did}/verification-methods`, 'POST'],
      [`${GATEWAY}/v1/dids`, 'GET'],
      [`${GATEWAY}/v1/dids/`, 'GET'],
      [`${GATEWAY}/v1/trust-registry/issuers`, 'POST'],
      [`${GATEWAY}/v1/trust-registry/issuers/${did}`, 'PUT'],
      [`${GATEWAY}/v1/trust-registry/issuers/${did}`, 'DELETE'],
      [`${GATEWAY}/v1/trust-registry/issuers/${did}/reject`, 'GET'],
      [`${GATEWAY}/v1/trust-registry/pending-requests`, 'GET'],
      [`${GATEWAY}/v1/credential-statuses/1`, 'GET'],
      [`${GATEWAY}/v1/ok`, 'GET']
    ] as const) {
      await assert.rejects(readOnlyFetch(url, { method }), /only reads DIDs and trust records/, `${method} ${url}`);
    }

    assert.equal(connections, before);

    await readOnlyFetch(`${GATEWAY}/v1/dids/${did}`);
    await readOnlyFetch(`${GATEWAY}/v1/trust-registry/issuers/${did}?vcType=${encodeURIComponent('urn:eudi:diploma:1')}`, { method: 'GET' });
    assert.deepEqual(seen.slice(count), [`/certnet/v1/dids/${did}`, `/certnet/v1/trust-registry/issuers/${did}?vcType=urn%3Aeudi%3Adiploma%3A1`]);
  });

  it('never sends an authorization header over plain http except to loopback', async () => {
    const remote = createGatewayFetch({ gatewayUrl: GATEWAY, localUrl: 'http://192.0.2.1:9', write: true });

    await assert.rejects(
      remote(`${GATEWAY}/v1/dids`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}', timeoutMs: 500 }),
      /never sent to the CertNet gateway over plain http/
    );
    assert.equal((await gatewayFetch(`${GATEWAY}/v1/ok`, { headers: { authorization: 'Bearer t' } })).status, 200);
  });
});
