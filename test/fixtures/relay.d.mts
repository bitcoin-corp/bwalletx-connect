// Types for the relay fixture (relay.mjs, a copy of bWalletX relay/relay.mjs): only what the tests use.
import type { Server } from 'node:http';

export const LEGACY_CLAIMS_UNTIL: number;
export function createRelay(opts?: {
  server?: Server;
  now?: () => number;
  log?: (x: unknown) => void;
  legacyUntil?: number;
  sessionClaimsFrom?: number;
  stateFile?: string | null;
}): { stats(): { channels: number; sockets: number }; flush(): void; close(): void; _sweep(): void };
