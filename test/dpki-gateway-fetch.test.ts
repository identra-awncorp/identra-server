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

const gatewayFetch = createGatewayFetch({ gatewayUrl: GATEWAY, localUrl: LOCAL });

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
