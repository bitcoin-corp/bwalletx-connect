import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // npm: ESM + CJS + types. @bsv/sdk stays a peer dependency.
    entry: { index: 'src/index.ts', server: 'src/server.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
    external: ['@bsv/sdk'],
  },
  {
    // One <script> tag: window.bWalletXConnect, with @bsv/sdk bundled in.
    entry: { 'bwalletx-connect': 'src/index.ts' },
    format: ['iife'],
    globalName: 'bWalletXConnect',
    platform: 'browser',
    minify: true,
    sourcemap: true,
    target: 'es2020',
    noExternal: [/.*/],
  },
]);
