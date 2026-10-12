import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import { IdentityLinkConflictError } from '../src/link';
import { createBwalletXAuth } from '../src/next';
import { memoryStore } from '../src/server';

const ORIGIN = 'https://app.example';
const secret = 's'.repeat(48);
const post = (path: string, body: unknown, origin = ORIGIN, cookie?: string) =>
  new Request(ORIGIN + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

async function signIn(auth: ReturnType<typeof createBwalletXAuth>, root = PrivateKey.fromRandom()) {
  const identityKey = root.toPublicKey().toString();
  const c = await (await auth.challenge(post('/c', { identityKey }))).json();
  const { signature } = await new ProtoWallet(root).createSignature({
    protocolID: c.protocolID,
    keyID: c.keyID,
    counterparty: 'anyone',
    data: Array.from(new TextEncoder().encode(c.message)),
  });
  return { identityKey, res: await auth.verify(post('/v', { identityKey, nonce: c.nonce, signature })) };
}

describe('Next adapter', () => {
  it('challenge → verify sets an httpOnly signed cookie that getSession reads', async () => {
    const auth = createBwalletXAuth({ origin: ORIGIN, store: memoryStore({ quiet: true }), secret, onVerified: () => ({ uid: 'u1', handle: '$al' }) });
    const { identityKey, res } = await signIn(auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identityKey, uid: 'u1', handle: '$al' });
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^bwx_session=[^;]+; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure/);
    const cookie = set.split(';')[0];
    const s = await auth.getSession(cookie);
    expect(s).toMatchObject({ sub: identityKey, uid: 'u1' });
    expect(await auth.getSession(new Request(ORIGIN, { headers: { cookie } }))).toMatchObject({ sub: identityKey });
    const sessionRes = await auth.session(new Request(ORIGIN, { headers: { cookie } }));
    expect(await sessionRes.json()).toMatchObject({ identityKey, handle: '$al' });
    const out = await auth.logout(post('/logout', {}, ORIGIN, cookie));
    expect(out.headers.get('set-cookie')).toMatch(/^bwx_session=; .*Max-Age=0/);
  });

  it('refuses a bad origin, a bad signature, and a forged cookie', async () => {
    const auth = createBwalletXAuth({ origin: ORIGIN, store: memoryStore({ quiet: true }), secret });
    expect((await auth.challenge(post('/c', { identityKey: '02' + 'ab'.repeat(32) }, 'https://evil.example'))).status).toBe(403);
    expect((await auth.verify(post('/v', { identityKey: '02' + 'ab'.repeat(32), nonce: 'x', signature: [1, 2, 3] }))).status).toBe(401);
    expect(await auth.getSession('bwx_session=eyJzdWIiOiJ4In0.AAAA')).toBeNull();
  });

  it('answers 409 when the identity is linked to another user, 403 when onVerified refuses', async () => {
    const conflict = createBwalletXAuth({
      origin: ORIGIN,
      store: memoryStore({ quiet: true }),
      secret,
      onVerified: (k) => {
        throw new IdentityLinkConflictError(k, 'someone-else');
      },
    });
    const r = (await signIn(conflict)).res;
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('IDENTITY_LINKED_TO_OTHER_USER');
    expect(r.headers.get('set-cookie')).toBeNull();
    const refuse = createBwalletXAuth({ origin: ORIGIN, store: memoryStore({ quiet: true }), secret, onVerified: () => false });
    expect((await signIn(refuse)).res.status).toBe(403);
  });

  it('throws without a secret (no default)', async () => {
    const prev = process.env.BWALLETX_SESSION_SECRET;
    delete process.env.BWALLETX_SESSION_SECRET;
    try {
      const auth = createBwalletXAuth({ origin: ORIGIN, store: memoryStore({ quiet: true }) });
      await expect(auth.challenge(post('/c', {}))).rejects.toThrow(/BWALLETX_SESSION_SECRET/);
      await expect(auth.getSession('')).rejects.toThrow(/secret/);
    } finally {
      if (prev !== undefined) process.env.BWALLETX_SESSION_SECRET = prev;
    }
  });
});
