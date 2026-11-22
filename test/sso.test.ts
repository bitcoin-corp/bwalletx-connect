import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearJwksCache, verifyHubToken } from '../src/sso/jwt';
import { clearEpochCache, createSso, handleSsoCallback, verifySiteSession, type SsoOptions } from '../src/sso/server';
import { b64url, decodeTx, encodeTx, pkceChallenge, safeReturnTo, txCookieName } from '../src/sso/shared';
import { readCookie } from '../src/session';

const HUB = 'https://id.example';
const SITE = 'https://site.example';
const KEY = '02' + 'ab'.repeat(32);
const SECRET = 'x'.repeat(40);
const enc = new TextEncoder();

let kp: CryptoKeyPair;
let jwk: JsonWebKey;
beforeAll(async () => {
  kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
});
afterEach(() => {
  clearJwksCache();
  clearEpochCache();
});

async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'ES256', kid: 'k1', typ: 'JWT' }, key = kp.privateKey) {
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  iss: HUB, sub: KEY, aud: 'site', iat: now(), exp: now() + 300, sid: 'sid1', epoch: 0, identityKey: KEY,
  paymail: 'alice@bwalletx.com', handle: '$alice', tier: 'standard', auth_time: now(), jti: 'j', ...over,
});

/** A fake hub: JWKS, /token and /session/epoch. */
function fakeHub(opts: { token?: () => Promise<string>; epoch?: { active: boolean; epoch: number } | 'down'; onToken?: (b: URLSearchParams) => void } = {}) {
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/.well-known/jwks.json') return Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] });
    if (u.pathname === '/token') {
      opts.onToken?.(new URLSearchParams(String(init?.body)));
      return Response.json({ id_token: await (opts.token ?? (() => sign(claims())))() });
    }
    if (u.pathname === '/session/epoch') {
      if (opts.epoch === 'down') throw new Error('down');
      return Response.json(opts.epoch ?? { active: true, epoch: 0 });
    }
    return new Response('nope', { status: 404 });
  };
  return { f, calls };
}

describe('verifyHubToken', () => {
  it('accepts a good token', async () => {
    const { f } = fakeHub();
    const c = await verifyHubToken(await sign(claims()), { hub: HUB, clientId: 'site', fetch: f });
    expect(c.identityKey).toBe(KEY);
  });
  it('refuses a token for another site (aud)', async () => {
    const { f } = fakeHub();
    await expect(verifyHubToken(await sign(claims({ aud: 'other' })), { hub: HUB, clientId: 'site', fetch: f })).rejects.toMatchObject({ code: 'bad_aud' });
  });
  it('refuses another issuer, an expired token, alg none/HS256 and a forged signature', async () => {
    const { f } = fakeHub();
    const o = { hub: HUB, clientId: 'site', fetch: f };
    await expect(verifyHubToken(await sign(claims({ iss: 'https://evil.example' })), o)).rejects.toMatchObject({ code: 'bad_iss' });
    await expect(verifyHubToken(await sign(claims({ exp: now() - 120 })), o)).rejects.toMatchObject({ code: 'expired' });
    const t = await sign(claims());
    const [, p] = t.split('.');
    await expect(verifyHubToken(`${b64url(enc.encode('{"alg":"none","kid":"k1"}'))}.${p}.`, o)).rejects.toMatchObject({ code: 'bad_alg' });
    await expect(verifyHubToken(`${b64url(enc.encode('{"alg":"HS256","kid":"k1"}'))}.${p}.abc`, o)).rejects.toMatchObject({ code: 'bad_alg' });
    const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    await expect(verifyHubToken(await sign(claims(), undefined, other.privateKey), o)).rejects.toMatchObject({ code: 'bad_signature' });
  });
});

describe('shared', () => {
  it('safeReturnTo keeps visitors on the site', () => {
    expect(safeReturnTo('/dash?x=1')).toBe('/dash?x=1');
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '', '/a\nb']) expect(safeReturnTo(bad)).toBe('/');
  });
  it('tx cookie round trip', async () => {
    const t = { state: 'S'.repeat(43), verifier: 'v'.repeat(64), returnTo: '/x' };
    expect(decodeTx(encodeTx(t))).toEqual(t);
    expect(decodeTx(encodeTx({ ...t, returnTo: '//evil' }))?.returnTo).toBe('/');
    expect((await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); // RFC 7636 B
  });
});

function callbackReq(params: Record<string, string>, cookie: string) {
  return new Request(`${SITE}/sso/callback?${new URLSearchParams(params)}`, { headers: { cookie } });
}
const setCookies = (r: Response) => r.headers.getSetCookie();

describe('handleSsoCallback', () => {
  const state = 'st'.repeat(22);
  const verifier = 'v'.repeat(64);
  const txCookie = `${txCookieName(state)}=${encodeTx({ state, verifier, returnTo: '/dashboard' })}`;

  it('exchanges the code with the verifier, sets the httpOnly site cookie and returns to returnTo', async () => {
    let sent: URLSearchParams | null = null;
    const { f } = fakeHub({ onToken: (b) => (sent = b) });
    const r = await handleSsoCallback(callbackReq({ code: 'c1', state, iss: HUB }, txCookie), { clientId: 'site', secret: SECRET, hub: HUB, fetch: f });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/dashboard');
    expect(sent!.get('code_verifier')).toBe(verifier);
    expect(sent!.get('redirect_uri')).toBe(`${SITE}/sso/callback`);
    const site = setCookies(r).find((c) => c.startsWith('bwx_site='))!;
    expect(site).toMatch(/HttpOnly/);
    expect(site).toMatch(/Secure/);
    expect(site).toMatch(/SameSite=Lax/);
    expect(setCookies(r).some((c) => c.startsWith(txCookieName(state) + '=;'))).toBe(true);
  });

  it('refuses a state that does not match this attempt', async () => {
    const { f, calls } = fakeHub();
    const r = await handleSsoCallback(callbackReq({ code: 'c1', state: 'zz'.repeat(22) }, txCookie), { clientId: 'site', secret: SECRET, hub: HUB, fetch: f });
    expect(r.headers.get('location')).toBe('/?sso_error=state');
    expect(calls).toEqual([]);
    expect(setCookies(r).some((c) => c.startsWith('bwx_site='))).toBe(false);
  });

  it('refuses a hub token for another site', async () => {
    const { f } = fakeHub({ token: () => sign(claims({ aud: 'other' })) });
    const r = await handleSsoCallback(callbackReq({ code: 'c1', state }, txCookie), { clientId: 'site', secret: SECRET, hub: HUB, fetch: f });
    expect(r.headers.get('location')).toBe('/dashboard?sso_error=bad_aud');
    expect(setCookies(r).some((c) => c.startsWith('bwx_site='))).toBe(false);
  });

  it('login_required (quiet check, no hub session) goes back signed out with no error', async () => {
    const { f } = fakeHub();
    const r = await handleSsoCallback(callbackReq({ error: 'login_required', state }, txCookie), { clientId: 'site', secret: SECRET, hub: HUB, fetch: f });
    expect(r.headers.get('location')).toBe('/dashboard');
  });

  it('onSignedIn can add a uid or refuse', async () => {
    const { f } = fakeHub();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, fetch: f, onSignedIn: () => ({ uid: 'u1' }) };
    const r = await handleSsoCallback(callbackReq({ code: 'c', state }, txCookie), o);
    const cookie = setCookies(r).find((c) => c.startsWith('bwx_site='))!.split(';')[0];
    const { session } = await verifySiteSession(new Request(SITE, { headers: { cookie } }), o);
    expect(session?.uid).toBe('u1');
    const r2 = await handleSsoCallback(callbackReq({ code: 'c', state }, txCookie), { ...o, onSignedIn: () => false });
    expect(r2.headers.get('location')).toBe('/dashboard?sso_error=refused');
  });
});

describe('verifySiteSession', () => {
  const state = 'st'.repeat(22);
  const txCookie = `${txCookieName(state)}=${encodeTx({ state, verifier: 'v'.repeat(64), returnTo: '/' })}`;
  async function signedIn(o: SsoOptions, tier: 'standard' | 'high' = 'standard') {
    const { f } = fakeHub({ token: () => sign(claims({ tier })) });
    const r = await handleSsoCallback(callbackReq({ code: 'c', state }, txCookie), { ...o, fetch: f });
    return setCookies(r).find((c) => c.startsWith('bwx_site='))!.split(';')[0];
  }

  it('a bumped hub epoch signs this site out', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t };
    const cookie = await signedIn(o);
    const ok = await verifySiteSession(new Request(SITE, { headers: { cookie } }), { ...o, fetch: fakeHub().f });
    expect(ok.session?.sub).toBe(KEY);
    t += 301_000; // past the 5 minute epoch cache
    const out = await verifySiteSession(new Request(SITE, { headers: { cookie } }), { ...o, fetch: fakeHub({ epoch: { active: true, epoch: 1 } }).f });
    expect(out.session).toBeNull();
    expect(out.setCookie[0]).toMatch(/^bwx_site=;.*Max-Age=0/);
  });

  it('checks the hub at most every 5 minutes', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t };
    const cookie = await signedIn(o);
    const hub = fakeHub({ epoch: { active: false, epoch: 0 } });
    t += 60_000;
    expect((await verifySiteSession(new Request(SITE, { headers: { cookie } }), { ...o, fetch: hub.f })).session).not.toBeNull();
    expect(hub.calls).toEqual([]);
  });

  it('hub down: a standard session carries on, a high-tier one is refused', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t };
    const std = await signedIn(o);
    const high = await signedIn(o, 'high');
    t += 301_000;
    const down = fakeHub({ epoch: 'down' }).f;
    expect((await verifySiteSession(new Request(SITE, { headers: { cookie: std } }), { ...o, fetch: down })).session).not.toBeNull();
    expect((await verifySiteSession(new Request(SITE, { headers: { cookie: high } }), { ...o, fetch: down })).session).toBeNull();
  });

  it('a high-tier session ends after 1 hour; a session for another client_id is refused', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t };
    const high = await signedIn(o, 'high');
    t += 3601_000;
    expect((await verifySiteSession(new Request(SITE, { headers: { cookie: high } }), { ...o, fetch: fakeHub().f })).session).toBeNull();
    t = Date.now();
    const std = await signedIn(o);
    expect((await verifySiteSession(new Request(SITE, { headers: { cookie: std } }), { ...o, clientId: 'other' })).session).toBeNull();
  });

  it('session route answers for the chip; logout clears the cookie and gives the hub logout URL', async () => {
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB };
    const sso = createSso(o);
    const cookie = await signedIn(o);
    const s = await (await sso.session(new Request(`${SITE}/sso/session`, { headers: { cookie } }))).json();
    expect(s).toMatchObject({ signedIn: true, identityKey: KEY, paymail: 'alice@bwalletx.com', tier: 'standard' });
    const out = await sso.logout(new Request(`${SITE}/sso/logout?everywhere=1`, { method: 'POST', headers: { cookie, origin: SITE } }));
    expect(await out.json()).toEqual({ ok: true, redirect: `${HUB}/logout?client_id=site&redirect_uri=${encodeURIComponent(SITE + '/')}` });
    expect(readCookie(out.headers.get('set-cookie'), 'bwx_site')).toBe('');
    const csrf = await sso.logout(new Request(`${SITE}/sso/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } }));
    expect(csrf.status).toBe(403);
  });
});
