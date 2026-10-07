import { PrivateKey } from '@bsv/sdk';
import WS from 'ws';
import { describe, expect, it } from 'vitest';
import { pairBwalletX, restorePairing, type PairStorage, type SocketLike } from '../src/pair';
import { signInWithBwalletX } from '../src/signin';
import { createChallenge, memoryStore, verifySignIn } from '../src/server';
import { fakePhone } from './phone';

// Talks to the real relay.bwallet.space. Run with: pnpm test:live
const ORIGIN = 'https://example.com';
const live = process.env.LIVE_RELAY === '1';
const siteSocket = (url: string) => new WS(url, { origin: ORIGIN }) as unknown as SocketLike;
const phoneSocket = (url: string) => new WS(url) as unknown as SocketLike;

describe.skipIf(!live)('live relay.bwallet.space', () => {
  it('pairs with a simulated phone, signs in, and reconnects after a reload', { timeout: 30_000 }, async () => {
    const store = memoryStore({ quiet: true });
    const m = new Map<string, string>();
    const storage: PairStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    const root = PrivateKey.fromRandom();
    let phone: ReturnType<typeof fakePhone> | undefined;
    let code = '';

    (globalThis as Record<string, unknown>).window = new EventTarget();
    const r = await signInWithBwalletX({
      challenge: (identityKey) => createChallenge({ origin: ORIGIN, identityKey, store }),
      discoverMs: 50,
      pairing: {
        origin: ORIGIN,
        storage,
        socket: siteSocket,
        onCode: (c) => (code = c),
        // The phone joins after the site's socket is up, as a person scanning would.
        onLink: (link) => setTimeout(() => (phone = fakePhone(link, phoneSocket, root, { burst: true })), 1500),
      },
    });
    expect(r.method).toBe('pairing');
    expect(code).toBe(phone!.code);
    expect(await verifySignIn({ origin: ORIGIN, store, ...r })).toBe(root.toPublicKey().toString());

    (r.wallet as unknown as { close(): void }).close();
    const again = await restorePairing({ storage, socket: siteSocket });
    const { publicKey } = await again!.getPublicKey({ identityKey: true });
    expect(publicKey).toBe(root.toPublicKey().toString());
    again!.close();
    phone!.ws!.close();
    delete (globalThis as Record<string, unknown>).window;
  });
});
