// @vitest-environment happy-dom
/**
 * 0.5.5: one wallet sheet from click to signed in.
 *   - sign-in is ONE batch of wallet calls (getPublicKey + createSignature together), the challenge first, no key;
 *   - no getPublicKey before sign-in when the identity is already known (connect() included);
 *   - the picker lists bWalletX once (window.CWI is the same extension) and is skipped when there is one wallet;
 *   - servers older than 0.5.5 (identity-bound challenge) still work.
 */
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { challengeWantsIdentityKey, signInAndVerify, signInWithBwalletX, waitIfLocked } from '../src/signin';
import { createChallenge, memoryStore, verifySignIn } from '../src/server';
import { autoChoice, brc100Option, cwiIsAnnounced, discoverWallets, handcashAdapter, pairingOption, type WalletOption } from '../src/wallets';
import { runConnect } from '../src/connect-flow';
import { IDENTITY_HINT_KEY, rememberedIdentity } from '../src/account';

const ORIGIN = 'https://example.com';
const store = memoryStore({ quiet: true });
const challenge = (identityKey?: string) => createChallenge({ origin: ORIGIN, identityKey, store });
/** A server on @bwalletx/connect 0.5.4: createChallenge refused a missing key with a 400. */
const oldServerChallenge = async (identityKey?: string) => {
  if (!identityKey) throw Object.assign(new Error('identityKey must be a compressed public key (66 hex chars)'), { status: 400 });
  return createChallenge({ origin: ORIGIN, identityKey, store });
};
const verify = (r: { identityKey: string; nonce: string; signature: number[] }) => verifySignIn({ origin: ORIGIN, store, ...r });

type Call = { m: string; t: number; args?: unknown };

/** A ProtoWallet that logs each call and how many were in flight at once (one batch = they overlap). */
function trackedWallet(root = PrivateKey.fromRandom(), o: { locked?: boolean } = {}) {
  const pw = new ProtoWallet(root);
  const calls: Call[] = [];
  let pending = 0;
  let maxPending = 0;
  const track = async <T>(m: string, run: () => Promise<T>, args?: unknown) => {
    calls.push({ m, t: Date.now(), args });
    pending++;
    maxPending = Math.max(maxPending, pending);
    await new Promise((r) => setTimeout(r, 10));
    try {
      return await run();
    } finally {
      pending--;
    }
  };
  const wallet = {
    isAuthenticated: async () => {
      calls.push({ m: 'isAuthenticated', t: Date.now() });
      return { authenticated: !o.locked };
    },
    waitForAuthentication: async () => {
      calls.push({ m: 'waitForAuthentication', t: Date.now() });
      return { authenticated: true };
    },
    getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => track('getPublicKey', () => pw.getPublicKey(a), a),
    createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => track('createSignature', () => pw.createSignature(a), a),
  } as unknown as WalletInterface;
  const sheetCalls = () => calls.filter((c) => c.m === 'getPublicKey' || c.m === 'createSignature').map((c) => c.m);
  return { wallet, calls, root, key: root.toPublicKey().toString(), sheetCalls, maxPending: () => maxPending };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
});

describe('signInWithBwalletX: one batch of wallet calls', () => {
  it('gets the challenge first with no key, then asks for the key and the signature together', async () => {
    const t = trackedWallet();
    const order: string[] = [];
    const seen: (string | undefined)[] = [];
    const r = await signInWithBwalletX({
      wallet: t.wallet,
      challenge: (k) => {
        seen.push(k);
        order.push('challenge');
        return challenge(k);
      },
    });
    expect(seen).toEqual([undefined]);
    expect(t.sheetCalls()).toEqual(['getPublicKey', 'createSignature']);
    expect(t.maxPending()).toBe(2); // both in flight at once: the wallet merges them into one sheet
    expect(await verify(r)).toBe(t.key);
  });

  it('does not call waitForAuthentication when the wallet is unlocked (it can raise a manifest sheet)', async () => {
    const t = trackedWallet();
    await signInWithBwalletX({ wallet: t.wallet, challenge });
    expect(t.calls.map((c) => c.m)).not.toContain('waitForAuthentication');
    const locked = trackedWallet(undefined, { locked: true });
    await waitIfLocked(locked.wallet);
    expect(locked.calls.map((c) => c.m)).toEqual(['isAuthenticated', 'waitForAuthentication']);
  });

  it('a keyless challenge only verifies for the key that signed it', async () => {
    const t = trackedWallet();
    const r = await signInWithBwalletX({ wallet: t.wallet, challenge });
    expect(await verify({ ...r, identityKey: PrivateKey.fromRandom().toPublicKey().toString() })).toBeNull();
  });

  it('a challenge made for a key still refuses any other key', async () => {
    const t = trackedWallet();
    const other = PrivateKey.fromRandom().toPublicKey().toString();
    const r = await signInWithBwalletX({ wallet: t.wallet, identityKey: t.key, challenge });
    // Bound to t.key: claiming another key fails even before the signature check.
    expect(await verify({ ...r, identityKey: other })).toBeNull();
  });

  it('with a known identity key, asks for the signature only (no getPublicKey)', async () => {
    const t = trackedWallet();
    const seen: (string | undefined)[] = [];
    const r = await signInWithBwalletX({ wallet: t.wallet, identityKey: t.key, challenge: (k) => (seen.push(k), challenge(k)) });
    expect(t.sheetCalls()).toEqual(['createSignature']);
    expect(seen).toEqual([t.key]);
    expect(await verify(r)).toBe(t.key);
  });
});

describe('old servers (0.5.4, identity-bound challenge)', () => {
  it('challengeNeedsIdentityKey keeps the old order', async () => {
    const t = trackedWallet();
    const seen: (string | undefined)[] = [];
    const r = await signInWithBwalletX({ wallet: t.wallet, challengeNeedsIdentityKey: true, challenge: (k) => (seen.push(k), oldServerChallenge(k)) });
    expect(seen).toEqual([t.key]);
    expect(t.sheetCalls()).toEqual(['getPublicKey', 'createSignature']);
    expect(t.maxPending()).toBe(1);
    expect(await verify(r)).toBe(t.key);
  });

  it('a refused keyless challenge is retried in the old order automatically', async () => {
    const t = trackedWallet();
    const seen: (string | undefined)[] = [];
    const r = await signInWithBwalletX({ wallet: t.wallet, challenge: (k) => (seen.push(k), oldServerChallenge(k)) });
    expect(seen).toEqual([undefined, t.key]);
    expect(t.sheetCalls()).toEqual(['getPublicKey', 'createSignature']);
    expect(await verify(r)).toBe(t.key);
  });

  it('recognises the old server error, and nothing else', () => {
    expect(challengeWantsIdentityKey(new Error('identityKey must be a compressed public key (66 hex chars)'))).toBe(true);
    expect(challengeWantsIdentityKey(new Error('origin not allowed'))).toBe(false);
  });

  it('createChallenge still validates a key when one is given', async () => {
    await expect(createChallenge({ origin: ORIGIN, identityKey: 'nope', store })).rejects.toThrow(/identityKey/);
  });
});

describe('remembered identity (repeat sign-in = the signature alone)', () => {
  it('uses the hint: one createSignature, no getPublicKey', async () => {
    const t = trackedWallet();
    const { result } = await signInAndVerify({ wallet: t.wallet, identityKeyHint: t.key, challenge, verify: async (r) => ({ ok: !!(await verify(r)) }) });
    expect(t.sheetCalls()).toEqual(['createSignature']);
    expect(result.identityKey).toBe(t.key);
  });

  it('a wrong hint (another account) fails verification once and is retried with the key asked for', async () => {
    const t = trackedWallet();
    const wrong = PrivateKey.fromRandom().toPublicKey().toString();
    const v = async (r: { identityKey: string; nonce: string; signature: number[] }) => {
      const ok = await verify(r);
      if (!ok) throw Object.assign(new Error('sign-in failed'), { status: 401 });
      return { identityKey: ok };
    };
    const { result, verified } = await signInAndVerify({ wallet: t.wallet, identityKeyHint: wrong, challenge, verify: v });
    expect(result.identityKey).toBe(t.key);
    expect(verified.identityKey).toBe(t.key);
    expect(t.sheetCalls()).toEqual(['createSignature', 'getPublicKey', 'createSignature']);
  });
});

describe('picker: dedupe and auto-pick', () => {
  const g = globalThis as unknown as { CWI?: unknown };
  afterEach(() => {
    delete g.CWI;
  });
  const announceWith = (wallet: WalletInterface, rdns = 'com.bwalletx.extension') => {
    const f = () => window.dispatchEvent(Object.assign(new Event('brc100:announceWallet'), { detail: { info: { rdns, name: 'bWalletX' }, wallet } }));
    window.addEventListener('brc100:requestWallet', f);
    return () => window.removeEventListener('brc100:requestWallet', f);
  };

  it('lists bWalletX once when window.CWI is the extension it announced', async () => {
    const t = trackedWallet();
    g.CWI = t.wallet;
    const stop = announceWith(t.wallet);
    const list = await discoverWallets({ ms: 20 });
    stop();
    expect(list.map((w) => w.name)).toEqual(['bWalletX']);
  });

  it('keeps window.CWI when it is a different wallet', async () => {
    const t = trackedWallet();
    const other = trackedWallet();
    g.CWI = other.wallet;
    const stop = announceWith(t.wallet);
    const list = await discoverWallets({ ms: 20 });
    stop();
    expect(list.map((w) => w.id)).toEqual(['com.bwalletx.extension', 'window.CWI']);
    expect(cwiIsAnnounced(other.wallet, list.slice(0, 1))).toBe(false);
  });

  it('one wallet in this browser → no picker, even with phone pairing offered', () => {
    const ext = brc100Option(trackedWallet().wallet, { id: 'com.bwalletx.extension', name: 'bWalletX', isBwalletX: true });
    const phone = pairingOption({ onLink: () => undefined, onCode: () => undefined, confirmCode: () => true });
    expect(autoChoice([ext, phone])).toBe(ext);
    expect(autoChoice([ext])).toBe(ext);
    expect(autoChoice([phone])).toBe(phone);
    expect(autoChoice([])).toBeNull();
  });

  it('a real choice → picker (undefined)', () => {
    const ext = brc100Option(trackedWallet().wallet, { id: 'a', name: 'bWalletX', isBwalletX: true });
    const yours = brc100Option(trackedWallet().wallet, { id: 'b', name: 'Yours' });
    const hc = handcashAdapter({ login: async () => ({ handle: 'x' }) });
    expect(autoChoice([ext, yours])).toBeUndefined();
    expect(autoChoice([ext, hc])).toBeUndefined();
    expect(autoChoice([ext, yours], true)).toBe(ext);
  });
});

describe('connect() (BwalletXProvider) signs in with one sheet', () => {
  /** A fake site: /c and /v backed by the real server helpers (0.5.5, or 0.5.4 behaviour with `old`). */
  const site = (o: { old?: boolean } = {}) => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const post = async (url: string, body: unknown) => {
      const b = (body ?? {}) as Record<string, unknown>;
      posts.push({ url, body: b });
      if (url === '/c') {
        try {
          return (await (o.old ? oldServerChallenge : challenge)(b.identityKey as string | undefined)) as unknown as Record<string, unknown>;
        } catch (e) {
          throw Object.assign(new Error((e as Error).message), { status: 400 });
        }
      }
      const k = await verify(b as { identityKey: string; nonce: string; signature: number[] });
      if (!k) throw Object.assign(new Error('sign-in failed'), { status: 401 });
      return { identityKey: k };
    };
    return { posts, post };
  };
  const noPicker = async () => {
    throw new Error('the picker must not open');
  };

  it('extension + phone pairing: no picker, no getPublicKey before the batch, signed in', async () => {
    const t = trackedWallet();
    const list: WalletOption[] = [brc100Option(t.wallet, { id: 'com.bwalletx.extension', name: 'bWalletX', isBwalletX: true }), pairingOption({ onLink: () => undefined, onCode: () => undefined, confirmCode: () => true })];
    const s = site();
    const r = await runConnect({ list, pick: noPicker, challengeUrl: '/c', verifyUrl: '/v', post: s.post });
    expect(r?.signedIn).toBe(true);
    expect(r?.identityKey).toBe(t.key);
    expect(t.sheetCalls()).toEqual(['getPublicKey', 'createSignature']);
    expect(t.maxPending()).toBe(2);
    expect(t.calls.map((c) => c.m)).not.toContain('waitForAuthentication');
    expect(s.posts[0]).toEqual({ url: '/c', body: {} });
    expect(rememberedIdentity()).toBe(t.key);
  });

  it('the next connect() uses the remembered key: the signature alone', async () => {
    const t = trackedWallet();
    localStorage.setItem(IDENTITY_HINT_KEY, t.key);
    const list = [brc100Option(t.wallet, { id: 'com.bwalletx.extension', name: 'bWalletX', isBwalletX: true })];
    const r = await runConnect({ list, pick: noPicker, challengeUrl: '/c', verifyUrl: '/v', post: site().post });
    expect(r?.signedIn).toBe(true);
    expect(t.sheetCalls()).toEqual(['createSignature']);
  });

  it('still signs in against a 0.5.4 server', async () => {
    const t = trackedWallet();
    const list = [brc100Option(t.wallet, { id: 'com.bwalletx.extension', name: 'bWalletX', isBwalletX: true })];
    const s = site({ old: true });
    const r = await runConnect({ list, pick: noPicker, challengeUrl: '/c', verifyUrl: '/v', post: s.post });
    expect(r?.signedIn).toBe(true);
    expect(s.posts.map((p) => p.url)).toEqual(['/c', '/c', '/v']);
    expect(t.sheetCalls()).toEqual(['getPublicKey', 'createSignature']);
  });

  it('without sign-in routes, connect() asks for the key once', async () => {
    const t = trackedWallet();
    const list = [brc100Option(t.wallet, { id: 'x', name: 'bWalletX', isBwalletX: true })];
    const r = await runConnect({ list, pick: noPicker, post: site().post });
    expect(r?.signedIn).toBe(false);
    expect(r?.identityKey).toBe(t.key);
    expect(t.sheetCalls()).toEqual(['getPublicKey']);
  });

  it('a closed picker resolves null; no wallet at all is NOT_FOUND', async () => {
    const a = brc100Option(trackedWallet().wallet, { id: 'a', name: 'A' });
    const b = brc100Option(trackedWallet().wallet, { id: 'b', name: 'B' });
    expect(await runConnect({ list: [a, b], pick: async () => null, post: site().post })).toBeNull();
    await expect(runConnect({ list: [], pick: noPicker, post: site().post })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
