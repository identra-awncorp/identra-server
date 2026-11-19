// Shared by the end-to-end tests: the app listens on 127.0.0.1:47400 (IDENTRA_TEST_PORT); wallets are the SDK's own
// (@identra/sdk-app), reaching the canonical origin through createMappedFetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { base64Decode, createMappedFetch, type Clock, type HttpFetch } from '@identra/sdk-core';
import { webCryptoRandom } from '@identra/sdk-core/webcrypto';
import {
  createCredentialVault,
  createInMemoryCredentialRepository,
  createInMemorySecretStorage,
  createSoftwareKeyStore,
  createWallet
} from '@identra/sdk-app';

import { randomIp, TEST_PORTAL_PASSWORD, testKeysDir } from './helpers';

export const PORT = Number(process.env.IDENTRA_TEST_PORT ?? 47400);
export const LOCAL = `http://127.0.0.1:${PORT}`;
export const ORIGIN = 'https://api-identra.awncorp.vn';
export const ISS = `${ORIGIN}/issuers/truong-mau`;
export const keysDir = testKeysDir();

/** A clock that tests can move forward; reset after use. */
export function adjustableClock() {
  let offsetMs = 0;

  return {
    now: () => new Date(Date.now() + offsetMs),
    advance: (seconds: number) => void (offsetMs += seconds * 1000),
    reset: () => void (offsetMs = 0)
  } satisfies Clock & Record<string, unknown>;
}


// The wallet's network: never follows redirects, honours timeoutMs (as in the SDK's tests).
export const nodeFetch: HttpFetch = async (url, init) => {
  const r = await fetch(url, {
    method: init?.method ?? 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(init?.timeoutMs ?? 10_000),
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {})
  });

  return { status: r.status, headers: r.headers, text: () => r.text() };
};
export const mappedFetch = createMappedFetch(nodeFetch, { [ORIGIN]: LOCAL });

/** DER of the first certificate of a PEM file. */
export const derOf = (pemPath: string) =>
  base64Decode(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END/.exec(readFileSync(pemPath, 'utf8'))![1]!.replace(/\s+/g, ''));

/** The SDK's own wallet, pinning the demo root (or `rootPemPath`), with an adjustable clock. */
export function newWallet(rootPemPath = join(keysDir, 'root.cert.pem')) {
  const clock = adjustableClock();
  const rootDer = derOf(rootPemPath);
  const wallet = createWallet({
    keyStore: createSoftwareKeyStore({ secrets: createInMemorySecretStorage(), random: webCryptoRandom }),
    vault: createCredentialVault({
      repository: createInMemoryCredentialRepository(),
      secrets: createInMemorySecretStorage(),
      random: webCryptoRandom,
      clock
    }),
    fetch: mappedFetch,
    random: webCryptoRandom,
    clock,
    trustedRoots: [rootDer],
    trustListUrl: `${ORIGIN}/trust-list`
  });

  return { wallet, clock };
}

/** JSON over the real listener, as the website would call it. */
export async function call(method: string, path: string, options: { token?: string; body?: unknown; ip?: string } = {}) {
  const res = await fetch(`${LOCAL}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {})
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await res.text();

  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

// Its own client address per sign-in, so the files' many logins do not share one per-IP budget.
export const login = async (username: string) =>
  (await call('POST', '/v1/demo/school/login', { body: { username, password: TEST_PORTAL_PASSWORD }, ip: randomIp() })).body.token as string;
export const newOffer = async (token: string) => {
  const res = await call('POST', '/v1/demo/school/offers', { token });

  assert.equal(res.status, 201, JSON.stringify(res.body));

  return res.body as { offerId: string; offerUri: string; txCode: string; expiresAt: string; serverTime: string };
};
export const offerState = async (token: string, offerId: string) => call('GET', `/v1/demo/school/offers/${offerId}`, { token });
export const wrongPin = (pin: string) => String((Number(pin) + 1) % 1_000_000).padStart(6, '0');


/** Issues sv001's diploma (or `username`'s) into `wallet` through the real portal and protocol. */
export async function issueDiplomaTo(wallet: ReturnType<typeof newWallet>['wallet'], username = 'sv001') {
  const offer = await newOffer(await login(username));
  const resolved = await wallet.offers.resolve(offer.offerUri);

  assert.ok(resolved.ok, JSON.stringify(resolved));

  const accepted = await wallet.offers.accept(resolved.offer, { txCode: offer.txCode });

  assert.ok(accepted.ok, JSON.stringify(accepted));

  return accepted.credentialId;
}
