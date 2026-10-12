import { describe, expect, it } from 'vitest';
import { readCookie, serializeCookie, signSession, verifySession } from '../src/session';

const secret = 'x'.repeat(40);
const sub = '02' + 'ab'.repeat(32);

describe('session signing', () => {
  it('round-trips claims', async () => {
    const t = await signSession({ sub, uid: 'u1', handle: '$alice' }, { secret, maxAge: 60 });
    const p = await verifySession(t, { secret });
    expect(p).toMatchObject({ sub, uid: 'u1', handle: '$alice' });
    expect(p!.exp - p!.iat).toBe(60);
  });

  it('rejects a tampered payload or signature', async () => {
    const t = await signSession({ sub }, { secret });
    const [body, sig] = t.split('.');
    const forged = btoa(JSON.stringify({ sub: '03' + 'cd'.repeat(32), iat: 0, exp: 9e9 })).replace(/=+$/, '');
    expect(await verifySession(`${forged}.${sig}`, { secret })).toBeNull();
    expect(await verifySession(`${body}.${sig.slice(0, -2)}AA`, { secret })).toBeNull();
    expect(await verifySession(`${body}`, { secret })).toBeNull();
    expect(await verifySession(42, { secret })).toBeNull();
    expect(await verifySession('a.b.c', { secret })).toBeNull();
  });

  it('rejects another secret', async () => {
    const t = await signSession({ sub }, { secret });
    expect(await verifySession(t, { secret: 'y'.repeat(40) })).toBeNull();
  });

  it('expires', async () => {
    const now = Date.now();
    const t = await signSession({ sub }, { secret, maxAge: 10, now });
    expect(await verifySession(t, { secret, now: now + 9_000 })).not.toBeNull();
    expect(await verifySession(t, { secret, now: now + 10_000 })).toBeNull();
  });

  it('has no default secret', async () => {
    await expect(signSession({ sub }, { secret: '' })).rejects.toThrow(/secret/);
    await expect(signSession({ sub }, { secret: 'short' })).rejects.toThrow(/32/);
    await expect(verifySession('a.b', { secret: undefined as unknown as string })).rejects.toThrow(/secret/);
  });

  it('serializes an HttpOnly cookie and reads it back', () => {
    const c = serializeCookie('abc.def', { name: 'bwx', maxAge: 5 });
    expect(c).toBe('bwx=abc.def; Path=/; Max-Age=5; HttpOnly; SameSite=Lax; Secure');
    expect(serializeCookie('v', { name: 'bwx', maxAge: 5, secure: false })).not.toMatch(/Secure/);
    expect(readCookie('a=1; bwx=abc.def; z=2', 'bwx')).toBe('abc.def');
    expect(readCookie('xbwx=1', 'bwx')).toBeNull();
    expect(readCookie(null, 'bwx')).toBeNull();
  });
});
