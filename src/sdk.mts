// The only place the server imports the Identra SDK. The SDK packages are ESM-only and their
// `exports` offer just the "import" condition, so CommonJS code cannot resolve them by name.
// This ES module re-exports them; the CommonJS code imports './sdk.mjs', which Node 24 loads
// with require(esm). If the SDK adds a "default" condition, this file can simply go.
export * from '@identra/sdk-core';
export { webCryptoHasher, webCryptoRandom, webCryptoVerifier } from '@identra/sdk-core/webcrypto';
export * from '@identra/sdk-server';
