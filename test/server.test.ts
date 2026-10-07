import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChallenge, loginMessage, memoryStore, originAllowed, verifySignIn } from '../src/server';

const ORIGIN = 'https://example.com';
const store = memoryStore({ quiet: true });

async function sign(root: PrivateKey, message: string, keyID: string) {
  const { signature } = await new ProtoWallet(root).createSignature({
    protocolID: [2, 'bwallet sign in'],
    keyID,
    counterparty: 'anyone',
    data: Array.from(new TextEncoder().encode(message)),
  });
  return signature;
}

describe('createChallenge / verifySignIn', () => {
  const root = PrivateKey.fromRandom();
  const identityKey = root.toPublicKey().toString();

  afterEach(() => vi.useRealTimers());

  it('accepts a valid signature and returns the identity key', async () => {
    const c = await createChallenge({ origin: ORIGIN, identityKey, store });
    expect(c.keyID).toBe(c.nonce);
    expect(c.message).toBe(loginMessage(ORIGIN, c.nonce, c.expiresAt));
    expect(c.message.split('\n')[0]).toBe('Sign in to example.com with bWallet');
    const signature = await sign(root, c.message, c.keyID);
    expect(await verifySignIn({ origin: ORIGIN, identityKey, nonce: c.nonce, signature, store })).toBe(identityKey);
  });

  it('refuses a replay of the same nonce and signature', async () => {
    const c = await createChallenge({ origin: ORIGIN, identityKey, store });
    const body = { origin: ORIGIN, identityKey, nonce: c.nonce, signature: await sign(root, c.message, c.keyID), store };
    expect(await verifySignIn(body)).toBe(identityKey);
    expect(await verifySignIn(body)).toBeNull();
  });

  it('refuses a signature by a different key, and burns the nonce', async () => {
    const c = await createChallenge({ origin: ORIGIN, identityKey, store });
    const bad = await sign(PrivateKey.fromRandom(), c.message, c.keyID);
    expect(await verifySignIn({ origin: ORIGIN, identityKey, nonce: c.nonce, signature: bad, store })).toBeNull();
    const good = await sign(root, c.message, c.keyID);
    expect(await verifySignIn({ origin: ORIGIN, identityKey, nonce: c.nonce, signature: good, store })).toBeNull();
  });

  it('refuses a signature made under another keyID', async () => {
    const c = await createChallenge({ origin: ORIGIN, identityKey, store });
    const signature = await sign(root, c.message, 'some-other-nonce');
    expect(await verifySignIn({ origin: ORIGIN, identityKey, nonce: c.nonce, signature, store })).toBeNull();
  });

  it('refuses an expired challenge', async () => {
    const c = await createChallenge({ origin: ORIGIN, identityKey, store });
    const signature = await sign(root, c.message, c.keyID);
    vi.useFakeTimers({ now: Date.now() + 2 * 60_000 + 1000 });
    expect(await verifySignIn({ origin: ORIGIN, identityKey, nonce: c.nonce, signature, store })).toBeNull();
  });

  it('refuses a challenge made for another origin', async () => {
    const c = await createChallenge({ origin: 'https://evil.example', identityKey, store });
    const signature = await sign(root, c.message, c.keyID);
    expect(await verifySignIn({ origin: ORIGIN, identityKey, nonce: c.nonce, signature, store })).toBeNull();
  });

  it('refuses when the identity key differs from the one challenged', async () => {
    const other = PrivateKey.fromRandom();
    const c = await createChallenge({ origin: ORIGIN, identityKey, store });
    const signature = await sign(other, c.message, c.keyID);
    expect(await verifySignIn({ origin: ORIGIN, identityKey: other.toPublicKey().toString(), nonce: c.nonce, signature, store })).toBeNull();
  });

  it('rejects malformed input', async () => {
    await expect(createChallenge({ origin: ORIGIN, identityKey: '02' + '00'.repeat(32), store })).rejects.toThrow();
    await expect(createChallenge({ origin: 'https://example.com/path', identityKey, store })).rejects.toThrow();
    expect(await verifySignIn({ origin: ORIGIN, identityKey, nonce: 42, signature: [], store })).toBeNull();
    const c = await createChallenge({ origin: ORIGIN, identityKey, store });
    expect(await verifySignIn({ origin: ORIGIN, identityKey, nonce: c.nonce, signature: 'nope', store })).toBeNull();
  });

  it('checks the Origin header exactly', () => {
    expect(originAllowed('https://example.com', ORIGIN)).toBe(true);
    expect(originAllowed('https://example.com.evil.io', ORIGIN)).toBe(false);
    expect(originAllowed(null, ORIGIN)).toBe(false);
  });

  it('warns once when the default memory store is used', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createChallenge({ origin: ORIGIN, identityKey });
    await createChallenge({ origin: ORIGIN, identityKey });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
