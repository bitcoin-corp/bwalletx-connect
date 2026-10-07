import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { signInWithBwalletX } from '../src/signin';
import { createChallenge, memoryStore, verifySignIn } from '../src/server';
import { FakeRelay } from './fake-relay';
import { fakePhone } from './phone';

const ORIGIN = 'https://example.com';
const store = memoryStore({ quiet: true });
const challenge = (identityKey: string) => createChallenge({ origin: ORIGIN, identityKey, store });
const verify = (r: { identityKey: string; nonce: string; signature: number[] }) => verifySignIn({ origin: ORIGIN, store, ...r });

function wallet(root: PrivateKey): WalletInterface {
  const pw = new ProtoWallet(root);
  return {
    waitForAuthentication: async () => ({ authenticated: true }),
    getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => pw.getPublicKey(a),
    createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => pw.createSignature(a),
  } as unknown as WalletInterface;
}

const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.window;
});

describe('signInWithBwalletX', () => {
  it('uses the extension when it announces com.bwalletx.extension', async () => {
    const root = PrivateKey.fromRandom();
    const w = new EventTarget() as EventTarget & { CWI?: unknown };
    w.addEventListener('brc100:requestWallet', () =>
      w.dispatchEvent(Object.assign(new Event('brc100:announceWallet'), { detail: { info: { rdns: 'com.bwalletx.extension' }, wallet: wallet(root) } })),
    );
    g.window = w;
    const r = await signInWithBwalletX({ challenge, discoverMs: 200 });
    expect(r.method).toBe('extension');
    expect(await verify(r)).toBe(root.toPublicKey().toString());
  });

  it('ignores other wallets and falls back to window.CWI as in-app', async () => {
    const root = PrivateKey.fromRandom();
    const w = new EventTarget() as EventTarget & { CWI?: unknown };
    w.addEventListener('brc100:requestWallet', () =>
      w.dispatchEvent(Object.assign(new Event('brc100:announceWallet'), { detail: { info: { rdns: 'com.example.other' }, wallet: wallet(PrivateKey.fromRandom()) } })),
    );
    w.CWI = wallet(root);
    g.window = w;
    const r = await signInWithBwalletX({ challenge, discoverMs: 100 });
    expect(r.method).toBe('in-app');
    expect(await verify(r)).toBe(root.toPublicKey().toString());
  });

  it('pairs when no wallet is in the page', async () => {
    g.window = new EventTarget();
    const relay = new FakeRelay(ORIGIN);
    const root = PrivateKey.fromRandom();
    const r = await signInWithBwalletX({
      challenge,
      discoverMs: 50,
      pairing: {
        origin: ORIGIN,
        storage: null,
        socket: relay.socket,
        onCode: () => {},
        onLink: (link) => setTimeout(() => fakePhone(link, relay.socket, root), 0),
      },
    });
    expect(r.method).toBe('pairing');
    expect(await verify(r)).toBe(root.toPublicKey().toString());
  });

  it('says NOT_FOUND when there is no wallet and no pairing UI', async () => {
    g.window = new EventTarget();
    await expect(signInWithBwalletX({ challenge, discoverMs: 20, reusePairing: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
