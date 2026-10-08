/**
 * @bwalletx/connect/shell — the bApp shell: manifest, web bar/topbar/drawer, in-wallet bridge.
 *
 *   import { defineBappShell, loadManifest, applyManifest, startShellBridge } from '@bwalletx/connect/shell';
 *   defineBappShell();
 *   const manifest = await loadManifest();          // /.well-known/bapp.json
 *   applyManifest(manifest);
 *   startShellBridge({ manifest });                 // in-wallet: hide bar, follow bapp:navigate
 */
export * from './manifest.js';
export * from './wallet.js';
export * from './elements.js';
