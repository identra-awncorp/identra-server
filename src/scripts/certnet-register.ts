// npm run certnet:register [-- did | recognise] — registers the hosted DID issuers (ADR-0020
// decision 7, docs/vc-api.md §4) with the CertNet gateway. Run once per environment; idempotent.
//
//   did        the issuer's own step: (a) generate orgs/<org>/did.key.pem (P-256, mode 600) unless
//              it exists (never overwritten, never printed); (b) unless orgs/<org>/did.json exists,
//              POST /v1/dids with its public key and write did.json from the answer, once the
//              returned document is checked to hold exactly this key under <did>#key-1 in
//              assertionMethod.
//   recognise  the accrediting body's step: (c) POST /v1/trust-registry/issuers for the DID in
//              did.json (vcTypes [diploma], scope education); "already registered" (409) is fine.
//   (none)     both, in that order.
//
// Needs IDENTRA_KEYS_DIR, CERTNET_GATEWAY_URL and CERTNET_NETWORK (CERTNET_GATEWAY_LOCAL_URL outside
// production; production, NODE_ENV or IDENTRA_DEPLOYMENT, refuses it and the `local` network).
// CERTNET_WRITE_TOKEN, when set, is sent as a bearer token (the contract's write authentication is
// TBD), over https, or plain http to loopback only (CERTNET_GATEWAY_LOCAL_URL). Every local check
// (the organisation directory is no link and not writable by group or others, no X.509 issuing
// files beside the DID files, an existing did.key.pem is a regular PKCS#8 P-256 file with mode 600,
// did.json is a regular file) runs before anything is sent. Exit codes: 0 done; 1 refused
// (configuration or local files); 2 the gateway did not answer or answered something else than the
// contract's success (also when the recognition cannot be read back); 3 the gateway's DID document
// does not hold our key; 4 the trust registry's record does not recognise the issuer for diplomas
// (the accrediting body must correct it; nothing is repaired here). Nothing is written by a step
// that does not succeed.
//
// Known limitation: when POST /v1/dids created the DID but its answer is lost or unusable (timeout,
// over 64 KB, not 201, not JSON; exit 2), did.json is not written and the contract has no way to
// find a DID by its key, so a rerun creates a second DID for the same key. The first one is never
// in the trust registry and nothing here uses it. Recovery: if the DID is known (the gateway's
// operator can find it by the time of the request and the public key), write did.json by hand as
// {"did": "<did>", "kid": "<did>#key-1"} and run `-- did` (it then sends nothing and checks the
// files as the server will); otherwise rerun, and ask the gateway's operator to deactivate the
// orphan (POST /v1/dids/<did>/deactivate).
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { createCertNetTrustRegistry, isCertNetDid, splitDidUrl, VCT, type HttpFetch } from '@identra/sdk-core';
import { createFileKeyStore } from '@identra/sdk-server';

import { certnetConfig, CertNetConfig } from '../config/env.validation';
import { createGatewayFetch } from '../vc/gateway-fetch';
import { HOSTED_ISSUERS } from '../vc/hosted-issuers';

const FRAGMENT = 'key-1';
const WRITE_TIMEOUT_MS = 30_000;
const MAX_BYTES = 65_536;
/** The X.509 issuing files: an organisation issues on one path only (ADR-0020 decision 1). */
const ISSUING_FILES = ['vc', 'vc-product', 'status'].flatMap((f) => [`${f}.key.pem`, `${f}.chain.pem`]);

class Stop extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 | 4
  ) {
    super(message);
  }
}

interface Context {
  keysDir: string;
  certnet: CertNetConfig;
  fetch: HttpFetch;
  token: string | undefined;
}

type PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

/** What the key store reads (sdk-server key-store.ts): a single PKCS#8 block. */
const PKCS8_PEM = /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----\s*$/;

/**
 * The public key of did.key.pem, which must be a regular file (not a link) readable by its owner
 * only, holding a PKCS#8 P-256 key: what the server's key store will accept.
 */
function publicJwkOf(path: string, label: string): PublicJwk {
  const st = lstatSync(path);

  if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Stop(`${label} must be a regular file with mode 600`, 1);

  let jwk: { kty?: string; crv?: string; x?: string; y?: string };

  try {
    const pem = readFileSync(path, 'utf8');

    if (!PKCS8_PEM.test(pem)) throw new Error('not PKCS#8');
    jwk = createPublicKey(createPrivateKey(pem)).export({ format: 'jwk' });
  } catch {
    throw new Stop(`${label} is not a single PKCS#8 PEM private key`, 1);
  }

  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Stop(`${label} is not an EC P-256 key`, 1);

  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/**
 * The DID of a CreateDid answer whose document holds exactly `jwk` as its only verification method
 * `<did>#key-1` (controller the DID) and lists only that key in assertionMethod; else null.
 */
function registeredDid(body: unknown, network: CertNetConfig['network'], jwk: PublicJwk): string | null {
  const { did, document: doc } = (typeof body === 'object' && body !== null ? body : {}) as { did?: unknown; document?: Record<string, unknown> };

  if (!isCertNetDid(did, network) || typeof doc !== 'object' || doc === null || doc.id !== did) return null;

  const kid = `${did}#${FRAGMENT}`;
  const vms = doc.verificationMethod;
  const vm = (Array.isArray(vms) && vms.length === 1 ? vms[0] : null) as { id?: unknown; controller?: unknown; publicKeyJwk?: Record<string, unknown> } | null;
  const key = vm?.publicKeyJwk;
  const assertion = doc.assertionMethod;

  if (vm?.id !== kid || vm.controller !== did || typeof key !== 'object' || key === null) return null;
  if (key.kty !== 'EC' || key.crv !== 'P-256' || key.x !== jwk.x || key.y !== jwk.y || 'd' in key) return null;

  return Array.isArray(assertion) && assertion.length > 0 && assertion.every((entry) => entry === kid) ? did : null;
}

async function post(ctx: Context, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  let res: Awaited<ReturnType<HttpFetch>>;

  try {
    res = await ctx.fetch(`${ctx.certnet.gatewayUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}) },
      body: JSON.stringify(body),
      timeoutMs: WRITE_TIMEOUT_MS,
      maxBytes: MAX_BYTES
    });
  } catch {
    throw new Stop(`POST ${path}: the gateway did not answer (unreachable, timeout, or an answer over 64 KB)`, 2);
  }

  const text = await res.text();

  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null };
  }
}

/** The contract's error code of an answer, when it has a plausible one (never other content). */
const codeOf = (json: unknown) => {
  const code = (json as { code?: unknown } | null)?.code;

  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? ` ${code}` : '';
};

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * The local checks of an organisation directory, before anything is sent: no link and not writable
 * by group or others, no X.509 issuing files (a link counts, even dangling), and did.json, if any
 * entry of that name exists, a regular file. True when did.json exists.
 */
function checkOrgDir(dir: string, org: string): boolean {
  const st = lstatSync(dir, { throwIfNoEntry: false });

  if (st?.isSymbolicLink()) throw new Stop(`orgs/${org} is a symbolic link`, 1);
  if (st === undefined || !st.isDirectory()) throw new Stop(`orgs/${org} is not a directory`, 1);
  if ((st.mode & 0o022) !== 0) throw new Stop(`orgs/${org} is writable by group or others; run chmod 700 on it`, 1);
  if (ISSUING_FILES.some((f) => present(join(dir, f)))) throw new Stop(`orgs/${org} holds X.509 issuing files; an organisation issues on one path only`, 1);

  const json = lstatSync(join(dir, 'did.json'), { throwIfNoEntry: false });

  if (json !== undefined && !json.isFile()) throw new Stop(`orgs/${org}/did.json must be a regular file (not a link)`, 1);

  return json !== undefined;
}

/** Steps (a) and (b) for one organisation. */
async function registerDid(ctx: Context, org: string): Promise<void> {
  const dir = join(ctx.keysDir, 'orgs', org);
  const keyPath = join(dir, 'did.key.pem');
  const jsonPath = join(dir, 'did.json');
  const keyLabel = `orgs/${org}/did.key.pem`;

  if (!present(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const registered = checkOrgDir(dir, org);

  if (present(keyPath)) publicJwkOf(keyPath, keyLabel);
  // A new key would never match a DID that is already registered.
  else if (registered) throw new Stop(`orgs/${org}/did.json exists without did.key.pem: restore the key, or remove did.json to register a new DID`, 1);

  if (registered) {
    console.log(`certnet:register: ${org}: already registered (orgs/${org}/did.json), nothing sent`);
  } else {
    // `wx` is the key's only existence check that counts: an existing key (checked above, or one
    // that appeared since) is never replaced. Created with mode 600, never printed.
    try {
      writeFileSync(keyPath, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      console.log(`certnet:register: ${org}: generated ${keyLabel} (mode 600)`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const publicKeyJwk = publicJwkOf(keyPath, keyLabel);
    const { status, json } = await post(ctx, '/v1/dids', {
      network: ctx.certnet.network,
      verificationMethods: [{ idFragment: FRAGMENT, type: 'JsonWebKey2020', publicKeyJwk, purposes: ['assertionMethod'] }]
    });

    if (status === 202) throw new Stop('POST /v1/dids: the gateway accepted the DID asynchronously (202) without returning it; did.json was not written', 2);
    if (status !== 201) throw new Stop(`POST /v1/dids answered HTTP ${status}${codeOf(json)}; did.json was not written`, 2);

    const did = registeredDid(json, ctx.certnet.network, publicKeyJwk);

    if (did === null) {
      throw new Stop(`POST /v1/dids: the returned DID document does not hold exactly this key as <did>#${FRAGMENT} in assertionMethod; did.json was not written`, 3);
    }

    writeFileSync(jsonPath, `${JSON.stringify({ did, kid: `${did}#${FRAGMENT}` }, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
    console.log(`certnet:register: ${org}: registered ${did} (orgs/${org}/did.json)`);
  }

  // What the server will load at start-up (the SDK key store's own checks).
  try {
    await createFileKeyStore(ctx.keysDir).didSigner!(org);
  } catch (error) {
    throw new Stop((error as Error).message, 1);
  }
}

/** Step (c) for one organisation. */
async function recognise(ctx: Context, org: string): Promise<void> {
  const label = `orgs/${org}/did.json`;
  const dir = join(ctx.keysDir, 'orgs', org);
  let did: unknown;

  if (present(dir)) checkOrgDir(dir, org);

  try {
    did = (JSON.parse(readFileSync(join(dir, 'did.json'), 'utf8')) as { did?: unknown }).did;
  } catch {
    throw new Stop(`${label} is missing or not JSON; run \`npm run certnet:register -- did\` first`, 1);
  }

  if (!isCertNetDid(did, ctx.certnet.network)) throw new Stop(`${label}: did is not a did:certnet DID of ${ctx.certnet.network}`, 1);

  const { status, json } = await post(ctx, '/v1/trust-registry/issuers', { issuerDid: did, vcTypes: [VCT.diploma], scopes: ['education'] });
  const outcome = { 201: 'recognised', 202: 'accepted by the gateway, pending', 409: 'already in the trust registry' }[status];

  if (outcome === undefined) throw new Stop(`POST /v1/trust-registry/issuers answered HTTP ${status}${codeOf(json)}`, 2);

  // Read back as a verifier does (recognised, diploma type held, within its dates): a 409 may be an
  // earlier record that rejects the issuer or lacks the type, and the operator must not think it ready.
  let trust: Awaited<ReturnType<ReturnType<typeof createCertNetTrustRegistry>['lookupIssuer']>>;

  try {
    trust = await createCertNetTrustRegistry({ gatewayUrl: ctx.certnet.gatewayUrl, network: ctx.certnet.network, fetch: ctx.fetch }).lookupIssuer(did, VCT.diploma, new Date());
  } catch {
    throw new Stop(`${did}: ${outcome}, but the trust registry could not be read back (gateway error)`, 2);
  }

  if (!trust.trusted) {
    throw new Stop(
      `${did}: ${outcome}, but the trust registry says: NOT recognised for diplomas (${trust.detail}); verifiers will refuse its documents. The accrediting body must correct the record (recognition "recognized", vcTypes holding ${VCT.diploma})`,
      4
    );
  }

  console.log(`certnet:register: ${org}: ${did}: ${outcome}; the trust registry says: recognised for diplomas`);
}

async function main(): Promise<void> {
  const step = process.argv[2] ?? 'all';
  const keysDir = process.env.IDENTRA_KEYS_DIR;

  if (!['all', 'did', 'recognise'].includes(step) || process.argv.length > 3) throw new Stop('usage: certnet:register [did | recognise]', 1);
  if (!keysDir || !isAbsolute(keysDir)) throw new Stop('set IDENTRA_KEYS_DIR (an absolute path)', 1);

  let certnet: CertNetConfig | null;

  try {
    certnet = certnetConfig(process.env);
  } catch (error) {
    throw new Stop((error as Error).message, 1);
  }

  if (!certnet) throw new Stop('DPKI is not configured: set CERTNET_GATEWAY_URL and CERTNET_NETWORK', 1);

  const ctx: Context = {
    keysDir,
    certnet,
    // The only write-enabled gateway fetch: the server's own is read-only.
    fetch: createGatewayFetch({ gatewayUrl: certnet.gatewayUrl, ...(certnet.localUrl ? { localUrl: certnet.localUrl } : {}), write: true }),
    token: process.env.CERTNET_WRITE_TOKEN || undefined
  };

  for (const { name } of HOSTED_ISSUERS.filter((issuer) => issuer.identification === 'did')) {
    if (step !== 'recognise') await registerDid(ctx, name);
    if (step !== 'did') await recognise(ctx, name);
  }
}

main().catch((error: unknown) => {
  // Messages name files, steps, HTTP statuses and contract codes, never key material or tokens.
  const code = (error as NodeJS.ErrnoException | null)?.code;

  console.error(`certnet:register refused: ${error instanceof Stop ? error.message : `unexpected error${typeof code === 'string' ? ` (${code})` : ''}`}`);
  process.exitCode = error instanceof Stop ? error.exitCode : 2;
});
