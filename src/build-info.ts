/**
 * The git commits inside the image (Dockerfile `--build-arg`s, docs: deploy/README.md), as short
 * SHAs: not secret, they let an operator see what runs. `unknown` outside an image build.
 */
const short = (value: string | undefined) => (value && /^[0-9a-f]{7,40}$/.test(value) ? value.slice(0, 7) : 'unknown');

export const BUILD = Object.freeze({
  server: short(process.env.IDENTRA_SERVER_REVISION),
  sdk: short(process.env.IDENTRA_SDK_REVISION)
});
