import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // npm: ESM + CJS + types. @bsv/sdk and react stay peer dependencies.
    entry: { index: 'src/index.ts', server: 'src/server.ts', element: 'src/define.ts', react: 'src/react.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'es2022',
    external: ['@bsv/sdk', 'react'],
  },
  {
    // One <script> tag: window.bWalletXConnect with @bsv/sdk bundled in, and <bwalletx-signin> registered.
    entry: { 'bwalletx-connect': 'src/browser.ts' },
    format: ['iife'],
    globalName: 'bWalletXConnect',
    platform: 'browser',
    minify: true,
    sourcemap: true,
    target: 'es2020',
    noExternal: [/.*/],
  },
]);
