/**
 * Security review round 2 (22 Nov 2026): one test (or more) per finding, written before the fix.
 *   HIGH-1  hub sign-in v2: admin-reserved protocol, message bound to a pending request + user code
 *   MED-1   client auth on /token and /session/epoch
 *   MED-2   epoch: hard grace period, 429 vs outage with backoff, authenticated batched calls
 *   LOWs    auth_time required, JWKS import can't crash, __Host- tx cookie, Sec-Fetch-Site on logout,
 *           logout hint = HMAC per client
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearJwksCache, verifyHubToken } from '../src/sso/jwt';
import { clearEpochCache, createSso, handleSsoCallback, verifySiteSession, type SsoOptions } from '../src/sso/server';
import {
  HUB_SIGNIN_PROTOCOL,
  HUB_WALLET_SIGNIN_PATH,
  b64url,
  checkLogoutHint,
  clientBasicAuth,
  encodeTx,
  hubSignInMessage,
  isHubUserCode,
  logoutHint,
  parseHubSignInMessage,
  txCookieName,
} from '../src/sso/shared';
import { HUB_SIGNIN_PROTOCOL as FROM_ROOT } from '../src/index';
import { HUB_SIGNIN_PROTOCOL as FROM_SERVER, LOGIN_PROTOCOL } from '../src/server';

const HUB = 'https://id.example';
const SITE = 'https://site.example';
const KEY = '02' + 'ab'.repeat(32);
const SECRET = 'x'.repeat(40);
const CLIENT_SECRET = 'c'.repeat(43);
const COOKIE = '__Host-bwx_site';
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

async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'ES256', kid: 'k1', typ: 'JWT' }) {
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  iss: HUB, sub: KEY, aud: 'site', iat: nowS(), exp: nowS() + 300, sid: 'sid1', epoch: 0, identityKey: KEY,
  paymail: null, handle: null, tier: 'standard', auth_time: nowS(), jti: 'j', ...over,
});

type EpochAnswer = { active: boolean; epoch: number } | 'down' | { status: number; retryAfter?: string };
/** A fake hub: JWKS (optionally with extra keys), /token and batched POST /session/epoch. Records headers. */
function fakeHub(o: { epoch?: EpochAnswer; extraKeys?: Record<string, unknown>[]; token?: () => Promise<string> } = {}) {
  const calls: { path: string; auth: string | null; body: string | null; method: string }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const h = new Headers(init?.headers);
    calls.push({ path: u.pathname, auth: h.get('authorization'), body: typeof init?.body === 'string' ? init.body : null, method: init?.method ?? 'GET' });
    if (u.pathname === '/.well-known/jwks.json') return Response.json({ keys: [...(o.extraKeys ?? []), { ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] });
    if (u.pathname === '/token') return Response.json({ id_token: await (o.token ?? (() => sign(claims())))() });
    if (u.pathname === '/session/epoch') {
      const e = o.epoch ?? { active: true, epoch: 0 };
      if (e === 'down') throw new Error('down');
      if ('status' in e) return new Response('{}', { status: e.status, headers: e.retryAfter ? { 'retry-after': e.retryAfter } : {} });
      const sids = (JSON.parse(String(init?.body)) as { sids: string[] }).sids;
      return Response.json({ sessions: sids.map((sid) => ({ sid, ...e })) });
    }
    return new Response('nope', { status: 404 });
  };
  return { f, calls };
}

const state = 'st'.repeat(22);
const txFor = (secure: boolean) => `${txCookieName(state, secure)}=${encodeTx({ state, verifier: 'v'.repeat(64), returnTo: '/' })}`;
const callbackReq = (cookie: string, base = SITE) => new Request(`${base}/sso/callback?${new URLSearchParams({ code: 'c', state })}`, { headers: { cookie } });
const siteCookie = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith(COOKIE + '='))!.split(';')[0];

async function signedIn(o: SsoOptions, sid = 'sid1') {
  const r = await handleSsoCallback(callbackReq(txFor(true)), { ...o, fetch: fakeHub({ token: () => sign(claims({ sid })) }).f });
  return siteCookie(r);
}

describe('HIGH-1: hub sign-in v2 (direct wallet → hub)', () => {
  it('the protocol is admin-reserved under BRC-100 (a website originator is refused it), one constant everywhere', () => {
    expect(HUB_SIGNIN_PROTOCOL).toEqual([2, 'admin bwalletx hub signin']);
    expect(HUB_SIGNIN_PROTOCOL[1].startsWith('admin')).toBe(true);
    expect(FROM_ROOT).toBe(HUB_SIGNIN_PROTOCOL);
    expect(FROM_SERVER).toBe(HUB_SIGNIN_PROTOCOL);
    expect(HUB_SIGNIN_PROTOCOL[1]).not.toBe(LOGIN_PROTOCOL[1]);
    expect(HUB_WALLET_SIGNIN_PATH).toBe('/api/wallet-signin');
  });

  it('the message binds hub, request, user code, site and time; parse is exact', () => {
    const issuedAt = Date.UTC(2026, 10, 22, 12, 0, 0);
    const f = { hub: 'https://id.bwalletx.com/', requestId: 'r'.repeat(22), userCode: 'BCDF-GHJK', clientId: 'bsvapi', issuedAt };
    const m = hubSignInMessage(f);
    expect(m).toBe(
      ['bWalletX hub sign-in v2', 'Hub: id.bwalletx.com', `Request: ${'r'.repeat(22)}`, 'Code: BCDF-GHJK', 'Site: bsvapi', 'Issued: 2026-11-22T12:00:00.000Z'].join('\n'),
    );
    expect(parseHubSignInMessage(m)).toEqual({ host: 'id.bwalletx.com', requestId: 'r'.repeat(22), userCode: 'BCDF-GHJK', clientId: 'bsvapi', issuedAt });
    expect(parseHubSignInMessage(hubSignInMessage({ ...f, clientId: null }))?.clientId).toBeNull();
    for (const bad of [m + '\n', m.replace('v2', 'v1'), m.replace('BCDF-GHJK', 'bcdf-ghjk'), m.replace('Hub: id', 'Hub:  id'), 'Sign in to id.bwalletx.com · challenge x · y', 42]) {
      expect(parseHubSignInMessage(bad)).toBeNull();
    }
    expect(() => hubSignInMessage({ ...f, userCode: 'AAAA-AAAA' })).toThrow(); // vowels are not in the alphabet
  });

  it('user codes: 8 letters from the 20 consonants, shown as XXXX-XXXX', () => {
    expect(isHubUserCode('BCDF-GHJK')).toBe(true);
    for (const bad of ['BCDFGHJK', 'bcdf-ghjk', 'AEIO-UBCD', 'BCDF-GHJ', 'BCDF-GHJKL', 42]) expect(isHubUserCode(bad)).toBe(false);
  });
});

describe('MED-1: client authentication', () => {
  it('Basic auth per RFC 6749 §2.3.1 (form-encoded id and secret)', () => {
    expect(clientBasicAuth('site', 'a b:c')).toBe('Basic ' + btoa('site:a+b%3Ac'));
  });

  it('the code exchange sends the client secret as Basic auth (never in the URL)', async () => {
    const hub = fakeHub();
    await handleSsoCallback(callbackReq(txFor(true)), { clientId: 'site', secret: SECRET, clientSecret: CLIENT_SECRET, hub: HUB, fetch: hub.f });
    const tok = hub.calls.find((c) => c.path === '/token')!;
    expect(tok.auth).toBe(clientBasicAuth('site', CLIENT_SECRET));
    expect(tok.body).not.toContain(CLIENT_SECRET);
  });

  it('the epoch check is an authenticated POST with the sid in the body', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, clientSecret: CLIENT_SECRET, hub: HUB, now: () => t };
    const cookie = await signedIn(o);
    t += 301_000;
    const hub = fakeHub();
    expect((await verifySiteSession(new Request(SITE, { headers: { cookie } }), { ...o, fetch: hub.f })).session).not.toBeNull();
    const e = hub.calls.find((c) => c.path === '/session/epoch')!;
    expect(e.method).toBe('POST');
    expect(e.auth).toBe(clientBasicAuth('site', CLIENT_SECRET));
    expect(JSON.parse(e.body!)).toEqual({ sids: ['sid1'] });
  });
});

describe('MED-2: epoch checks', () => {
  it('hub unreachable: a standard session carries on within the grace period (24 h default), then is refused', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t };
    const cookie = await signedIn(o);
    const req = () => new Request(SITE, { headers: { cookie } });
    const down = fakeHub({ epoch: 'down' }).f;
    t += 23 * 3600_000;
    const within = await verifySiteSession(req(), { ...o, fetch: down });
    expect(within.session).not.toBeNull();
    expect(within.hub).toBe('unavailable');
    clearEpochCache(); // no backoff carry-over between the two checks
    t += 2 * 3600_000; // 25 h since the last good check
    const after = await verifySiteSession(req(), { ...o, fetch: down });
    expect(after.session).toBeNull();
    expect(after.setCookie).toEqual([]); // not cleared: it works again once the hub answers
    // still backing off (no call to a hub that just failed)…
    const hub = fakeHub();
    expect((await verifySiteSession(req(), { ...o, fetch: hub.f })).session).toBeNull();
    expect(hub.calls).toEqual([]);
    // …then the hub answers and the same cookie works again
    t += 10_000;
    expect((await verifySiteSession(req(), { ...o, fetch: hub.f })).session).not.toBeNull();
  });

  it('the grace period is configurable', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t, epochGraceSeconds: 600 };
    const cookie = await signedIn(o);
    t += 601_000;
    expect((await verifySiteSession(new Request(SITE, { headers: { cookie } }), { ...o, fetch: fakeHub({ epoch: 'down' }).f })).session).toBeNull();
  });

  it('429 is not an outage: Retry-After is honoured (no calls until then), the session carries on', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t };
    const cookie = await signedIn(o);
    const req = () => new Request(SITE, { headers: { cookie } });
    t += 301_000;
    const busy = fakeHub({ epoch: { status: 429, retryAfter: '60' } });
    const r1 = await verifySiteSession(req(), { ...o, fetch: busy.f });
    expect(r1.session).not.toBeNull();
    expect(r1.hub).toBe('rate_limited');
    t += 30_000;
    const r2 = await verifySiteSession(req(), { ...o, fetch: busy.f });
    expect(r2.hub).toBe('rate_limited');
    expect(busy.calls.filter((c) => c.path === '/session/epoch')).toHaveLength(1); // backing off
    t += 31_000;
    const ok = fakeHub();
    expect((await verifySiteSession(req(), { ...o, fetch: ok.f })).hub).toBe('ok');
    expect(ok.calls.filter((c) => c.path === '/session/epoch')).toHaveLength(1);
  });

  it('an outage backs off too (no stampede on a dead hub), and is reported as unavailable', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t };
    const cookie = await signedIn(o);
    t += 301_000;
    const down = fakeHub({ epoch: { status: 503 } });
    for (let i = 0; i < 3; i++) await verifySiteSession(new Request(SITE, { headers: { cookie } }), { ...o, fetch: down.f });
    expect(down.calls.filter((c) => c.path === '/session/epoch')).toHaveLength(1);
  });

  it('concurrent checks are batched into one call (deduplicated)', async () => {
    let t = Date.now();
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB, now: () => t };
    const a = await signedIn(o, 'sidA1234');
    const b = await signedIn(o, 'sidB1234');
    const c = await signedIn(o, 'sidC1234');
    t += 301_000;
    const hub = fakeHub();
    const res = await Promise.all([a, b, c, a].map((cookie) => verifySiteSession(new Request(SITE, { headers: { cookie } }), { ...o, fetch: hub.f })));
    expect(res.every((r) => r.session)).toBe(true);
    const ep = hub.calls.filter((x) => x.path === '/session/epoch');
    expect(ep).toHaveLength(1);
    expect((JSON.parse(ep[0].body!) as { sids: string[] }).sids.sort()).toEqual(['sidA1234', 'sidB1234', 'sidC1234']);
  });
});

describe('LOWs', () => {
  it('a token without auth_time (or one in the future) is refused', async () => {
    const { f } = fakeHub();
    const { auth_time: _drop, ...noAuth } = claims();
    void _drop;
    await expect(verifyHubToken(await sign(noAuth), { hub: HUB, clientId: 'site', fetch: f })).rejects.toMatchObject({ code: 'bad_token' });
    await expect(verifyHubToken(await sign(claims({ auth_time: nowS() + 3600 })), { hub: HUB, clientId: 'site', fetch: f })).rejects.toMatchObject({ code: 'bad_token' });
  });

  it('a malformed key in the JWKS is skipped, never an unhandled rejection', async () => {
    const { f } = fakeHub({ extraKeys: [{ kty: 'EC', crv: 'P-256', kid: 'bad', x: 'AAAA', y: 'AAAA' }] });
    const c = await verifyHubToken(await sign(claims()), { hub: HUB, clientId: 'site', fetch: f });
    expect(c.identityKey).toBe(KEY);
    await expect(verifyHubToken(await sign(claims(), { alg: 'ES256', kid: 'bad' }), { hub: HUB, clientId: 'site', fetch: f })).rejects.toMatchObject({ code: 'unknown_key' });
  });

  it('tx cookie: __Host- on https (a sibling subdomain cannot plant one); plain only on http://localhost', async () => {
    expect(txCookieName(state, true)).toBe('__Host-bwx_sso_' + state.slice(0, 12));
    expect(txCookieName(state, false)).toBe('bwx_sso_' + state.slice(0, 12));
    // a non-__Host- tx cookie on https is ignored: state check fails, nothing is exchanged
    const hub = fakeHub();
    const planted = await handleSsoCallback(callbackReq(txFor(false)), { clientId: 'site', secret: SECRET, hub: HUB, fetch: hub.f });
    expect(planted.headers.get('location')).toBe('/?sso_error=state');
    expect(hub.calls).toEqual([]);
    const ok = await handleSsoCallback(callbackReq(txFor(true)), { clientId: 'site', secret: SECRET, hub: HUB, fetch: fakeHub().f });
    expect(ok.headers.getSetCookie().some((c) => c.startsWith(`${txCookieName(state, true)}=;`) && /Secure/.test(c))).toBe(true);
    const local = await handleSsoCallback(callbackReq(txFor(false), 'http://localhost:3401'), { clientId: 'site', secret: SECRET, hub: HUB, fetch: fakeHub().f });
    expect(local.headers.get('location')).toBe('/');
  });

  it('logout checks Sec-Fetch-Site: only same-origin (a sibling subdomain is same-site, not same-origin)', async () => {
    const o: SsoOptions = { clientId: 'site', secret: SECRET, hub: HUB };
    const sso = createSso(o);
    const cookie = await signedIn(o);
    const out = (h: Record<string, string>) => sso.logout(new Request(`${SITE}/sso/logout`, { method: 'POST', headers: { cookie, ...h } }));
    expect((await out({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await out({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await out({ origin: SITE, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await out({ origin: SITE, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('logout hint is an HMAC with the client secret: bound to client and sid, 5 minutes', async () => {
    const t = 1_800_000_000;
    const c = { clientId: 'site', clientSecret: CLIENT_SECRET };
    const h = await logoutHint('sid-abcdefgh', c, t);
    expect(await checkLogoutHint(h, 'sid-abcdefgh', c, t + 10)).toBe(true);
    expect(await checkLogoutHint(h, 'sid-abcdefgh', { ...c, clientSecret: 'd'.repeat(43) }, t + 10)).toBe(false);
    expect(await checkLogoutHint(h, 'sid-abcdefgh', { ...c, clientId: 'other' }, t + 10)).toBe(false);
    expect(await checkLogoutHint(h, 'sid-other000', c, t + 10)).toBe(false);
    expect(await checkLogoutHint(h, 'sid-abcdefgh', c, t + 301)).toBe(false);
    // the old unkeyed form (SHA-256 of the sid) is no longer accepted
    const digest = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`bwx-logout:sid-abcdefgh:${t}`))));
    expect(await checkLogoutHint(`${t}.${digest}`, 'sid-abcdefgh', c, t + 10)).toBe(false);
  });

  it('"Sign out of all" carries a hint only when the site has its client secret', async () => {
    const o: SsoOptions = { clientId: 'site', secret: SECRET, clientSecret: CLIENT_SECRET, hub: HUB };
    const cookie = await signedIn(o);
    const r = await createSso(o).logout(new Request(`${SITE}/sso/logout?everywhere=1`, { method: 'POST', headers: { cookie, origin: SITE } }));
    const u = new URL(((await r.json()) as { redirect: string }).redirect);
    expect(await checkLogoutHint(u.searchParams.get('logout_hint'), 'sid1', { clientId: 'site', clientSecret: CLIENT_SECRET })).toBe(true);
    const noSecret = await createSso({ ...o, clientSecret: undefined }).logout(new Request(`${SITE}/sso/logout?everywhere=1`, { method: 'POST', headers: { cookie, origin: SITE } }));
    expect(new URL(((await noSecret.json()) as { redirect: string }).redirect).searchParams.get('logout_hint')).toBeNull();
  });
});
