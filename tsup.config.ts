import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const version = (pkg: string): { version: string; license: string } =>
  JSON.parse(readFileSync(new URL(`./node_modules/${pkg}/package.json`, import.meta.url), 'utf8'));
const own = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const sdk = version('@bsv/sdk');
const qr = version('qrcode-generator');
const read = (path: string) => readFileSync(new URL(`./node_modules/${path}`, import.meta.url), 'utf8');
const sdkNotice = read('@bsv/sdk/NOTICE').trim().replace(/\s+/g, ' ').replace(/\*\//g, '');
const qrCopyright = /Copyright \(c\) [^\n]+/.exec(read('qrcode-generator/qrcode.js'))?.[0].trim() ?? 'Copyright (c) Kazuhiko Arase';

/**
 * Licence banner for the build that bundles @bsv/sdk and qrcode-generator. Read from the installed packages, so it
 * names what was actually bundled. The full notices ship in the package: THIRD_PARTY_LICENSES.md, third-party/.
 */
const GLOBAL_BANNER =
  `/*! @bwalletx/connect ${own.version} | MIT | https://github.com/bitcoin-corp/bwalletx-connect\n` +
  ` * Bundles @bsv/sdk ${sdk.version} (${sdk.license}; NOTICE: ${sdkNotice}) and\n` +
  ` * qrcode-generator ${qr.version} (${qr.license}; ${qrCopyright}).\n` +
  ` * Their licences and notices (@bsv/sdk's LICENSE, NOTICE, PATENTS, THIRD_PARTY_NOTICES.md, LICENSES/) are in\n` +
  ` * THIRD_PARTY_LICENSES.md and third-party/bsv-sdk/ of the @bwalletx/connect npm package. */`;

export default defineConfig([
  {
    // npm: ESM + CJS + types. @bsv/sdk (a dependency since 0.8.0) stays external: the app's installer resolves connect's
    // own copy, and dedupes it with the app's when the versions are compatible. react/next are optional peers.
    entry: {
      index: 'src/index.ts', server: 'src/server.ts', next: 'src/next.ts', element: 'src/define.ts', react: 'src/react.ts',
      shell: 'src/shell/index.ts', 'shell-react': 'src/shell/react.ts',
      sso: 'src/sso/index.ts', 'sso-server': 'src/sso/server.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
    external: ['@bsv/sdk', 'react', 'next', 'next/headers'],
  },
  {
    // One <script> tag: window.bWalletXConnect with @bsv/sdk bundled in, and <bwalletx-signin> registered.
    entry: { 'bwalletx-connect': 'src/browser.ts' },
    format: ['iife'],
    globalName: 'bWalletXConnect',
    platform: 'browser',
    banner: { js: GLOBAL_BANNER },
    minify: true,
    sourcemap: true,
    target: 'es2020',
    noExternal: [/.*/],
  },
  {
    // One <script> tag: window.bWalletXShell, <bwalletx-bar>/<bwalletx-topbar>/<bwalletx-drawer> registered. No @bsv/sdk.
    entry: { 'bwalletx-shell': 'src/shell/browser.ts' },
    format: ['iife'],
    globalName: 'bWalletXShell',
    platform: 'browser',
    minify: true,
    sourcemap: true,
    target: 'es2020',
  },
  {
    // One <script> tag for static sites: window.bwxSso (b*X single sign-on button + chip). No @bsv/sdk.
    entry: { 'bwalletx-sso': 'src/sso/global.ts' },
    format: ['iife'],
    globalName: 'bWalletXSso',
    platform: 'browser',
    minify: true,
    sourcemap: true,
    target: 'es2020',
    footer: { js: 'window.bwxSso=bWalletXSso.bwxSso;' },
  },
]);
