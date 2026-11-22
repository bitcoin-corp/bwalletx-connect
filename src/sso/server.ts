/**
 * Site side of b*X single sign-on, server half. Web Request/Response only, so the same code runs in Next.js route
 * handlers, Vercel functions, Hono, Remix, Bun and Workers.
 *
 *   // lib/sso.ts
 *   export const sso = createSso({ clientId: 'bsvapi', secret: process.env.BWX_SITE_SECRET! });
 *   // app/sso/callback/route.ts → export const GET = sso.callback;
 *   // app/sso/session/route.ts  → export const GET = sso.session;
 *   // app/sso/logout/route.ts   → export const POST = sso.logout;
 *   // anywhere on the server:    const { session } = await sso.verify(req);
 *
 * Rule zero: a session proves WHO the visitor is. It never authorises spending: every payment, signature or transfer
 * still goes through a wallet approval sheet.
 */
import { readCookie, serializeCookie, signSession, verifySession, type SessionPayload } from '../session.js';
import { SsoError, verifyHubToken, type HubClaims } from './jwt.js';
import {
  DEFAULT_CALLBACK_PATH,
  DEFAULT_HUB,
  SITE_COOKIE,
  SITE_COOKIE_SECURE,
  TIER_SESSION_SECONDS,
  decodeTx,
  hubOrigin,
  logoutHint,
  randomToken,
  safeReturnTo,
  sameString,
  txCookieName,
  type RiskTier,
} from './shared.js';

export { SsoError, verifyHubToken, clearJwksCache } from './jwt.js';
export type { VerifyHubTokenOptions } from './jwt.js';
export type { HubClaims } from './jwt.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The claims your site's own session cookie holds (iat/exp are added when it is signed). */
export interface SiteSessionClaims {
  /** The proven identity key. */
  sub: string;
  /** The client_id it is for (checked on every read). */
  aud: string;
  /** Hub session id and the epoch it had; a different epoch at the hub ends this session. */
  sid: string;
  ep: number;
  tier: RiskTier;
  paymail?: string;
  handle?: string;
  /** Your own user id, if onSignedIn returned one. */
  uid?: string;
  /** When the hub epoch was last checked, seconds. */
  chk: number;
  /** When this session first started (sliding refreshes keep it), seconds. */
  st: number;
  /** When the visitor last proved the wallet at the hub (the ID token's auth_time), seconds. See requireFresh. */
  at?: number;
  /** This site session's own id (for revocation on "Sign out of this site"). */
  sj?: string;
  /** Anything onSignedIn added. */
  [claim: string]: unknown;
}

export type SiteSession = SiteSessionClaims & SessionPayload & { iat: number; exp: number };

export interface SsoOptions {
  /** Your client_id in the hub's registry. */
  clientId: string;
  /** HMAC secret for your site's session cookie, 32+ chars, from env. Never commit it. */
  secret: string;
  /** Default https://id.bwalletx.com. */
  hub?: string;
  /** Default /sso/callback. Must match the redirect URI registered for your site. */
  callbackPath?: string;
  /**
   * Your origin(s) from config, e.g. ['https://www.bsvapi.com', 'https://bsvapi.com']. When set, the callback only
   * accepts requests on these origins. Default: the request's own origin (the hub still checks the redirect URI exactly).
   */
  origins?: string[];
  /** Cookie name. Default __Host-bwx_site on https, bwx_site on http://localhost. */
  cookieName?: string;
  /** Default: true unless the site runs on http://localhost. */
  secureCookie?: boolean;
  /** How long a hub epoch answer is trusted, seconds. Default 300 (the spec's ≤ 5 min). */
  epochCacheSeconds?: number;
  /**
   * After the hub's token is verified, before your cookie is set: map the identity to your user, look things up.
   * Return extra claims (uid…) to store, or false to refuse the sign-in.
   */
  onSignedIn?: (claims: HubClaims, req: Request) => Promise<Record<string, unknown> | void | false> | Record<string, unknown> | void | false;
  /**
   * Optional server-side record of site sessions signed out with "Sign out of this site". Without one, site sessions
   * are stateless signed cookies: signing out clears the cookie in this browser, but a copy of that cookie taken
   * earlier stays valid until it expires (30 days standard, 1 hour high) or the hub session ends ("Sign out of all").
   */
  revocations?: SiteRevocationStore;
  fetch?: FetchLike;
  /** ms since the epoch, for tests. */
  now?: () => number;
}

/** Where revoked site session ids are kept until they would have expired anyway. take/put must be shared between instances. */
export interface SiteRevocationStore {
  revoke(id: string, untilS: number): Promise<void> | void;
  isRevoked(id: string): Promise<boolean> | boolean;
}

/** In-memory revocations: development and tests only (not shared between instances, lost on restart). */
export function memoryRevocations(now: () => number = Date.now): SiteRevocationStore {
  const m = new Map<string, number>();
  return {
    revoke(id, untilS) {
      const t = Math.floor(now() / 1000);
      for (const [k, v] of m) if (v < t) m.delete(k);
      m.set(id, untilS);
    },
    isRevoked(id) {
      const u = m.get(id);
      return u !== undefined && u >= Math.floor(now() / 1000);
    },
  };
}

export interface VerifyResult {
  session: SiteSession | null;
  /** Set-Cookie values to send back (sliding refresh, epoch check stamp, or clearing a dead session). */
  setCookie: string[];
}

const nowS = (o: SsoOptions) => Math.floor((o.now?.() ?? Date.now()) / 1000);
const isLocalhost = (u: URL) => u.hostname === 'localhost';
const secureFor = (o: SsoOptions, req: Request) => o.secureCookie ?? !isLocalhost(new URL(req.url));

/** The site cookie's name for this request: __Host-bwx_site on https, bwx_site on http://localhost (or your cookieName). */
export function siteCookieName(o: Pick<SsoOptions, 'cookieName' | 'secureCookie'>, req?: Request): string {
  if (o.cookieName) return o.cookieName;
  const secure = o.secureCookie ?? (req ? !isLocalhost(new URL(req.url)) : true);
  return secure ? SITE_COOKIE_SECURE : SITE_COOKIE;
}

// Hub epoch answers shared by requests in this process, keyed by hub + sid.
const epochCache = new Map<string, { at: number; active: boolean; epoch: number | null }>();
export function clearEpochCache(): void {
  epochCache.clear();
}

function txClear(name: string, secure: boolean): string {
  return serializeCookie('', { name, maxAge: 0, secure, sameSite: 'Lax', path: '/' });
}

function siteOrigin(o: SsoOptions, req: Request): string | null {
  const origin = new URL(req.url).origin;
  if (!o.origins) return origin;
  return o.origins.map((x) => new URL(x).origin).includes(origin) ? origin : null;
}

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 303, headers: h });
}

function withQuery(path: string, k: string, v: string): string {
  const u = new URL(safeReturnTo(path), 'https://x.invalid');
  u.searchParams.set(k, v);
  return safeReturnTo(u.pathname + u.search + u.hash);
}

/** Make the site cookie for a session (also used for sliding refreshes). */
async function sessionCookie(o: SsoOptions, req: Request, s: SiteSessionClaims): Promise<string> {
  const maxAge = TIER_SESSION_SECONDS[s.tier];
  // A high-tier session never slides past 1 h from its start; a standard one runs 30 days from the last refresh.
  const remaining = s.tier === 'high' ? Math.max(1, s.st + maxAge - nowS(o)) : maxAge;
  const token = await signSession(s, { secret: o.secret, maxAge: remaining, now: o.now?.() });
  return serializeCookie(token, { name: siteCookieName(o, req), maxAge: remaining, secure: secureFor(o, req), sameSite: 'Lax', path: '/' });
}

/** A Set-Cookie value that deletes the site session. */
export function clearSiteCookie(o: Pick<SsoOptions, 'cookieName' | 'secureCookie'>, req?: Request): string {
  const secure = o.secureCookie ?? (req ? !isLocalhost(new URL(req.url)) : true);
  return serializeCookie('', { name: siteCookieName(o, req), maxAge: 0, secure, sameSite: 'Lax', path: '/' });
}

/**
 * GET /sso/callback?code=&state= (or ?error=). Checks state against this attempt's cookie, exchanges the code with
 * the PKCE verifier, verifies the hub's ID token (signature via JWKS, iss, aud = clientId, exp), runs onSignedIn,
 * sets the site's own httpOnly session cookie and sends the visitor to returnTo (always a path on this site).
 */
export async function handleSsoCallback(req: Request, o: SsoOptions): Promise<Response> {
  const url = new URL(req.url);
  const hub = hubOrigin(o.hub ?? DEFAULT_HUB);
  const secure = secureFor(o, req);
  const state = url.searchParams.get('state') ?? '';
  const name = state ? txCookieName(state) : '';
  const tx = name ? decodeTx(readCookie(req.headers.get('cookie'), name)) : null;
  const clear = name ? [txClear(name, secure)] : [];
  const back = safeReturnTo(tx?.returnTo, '/');
  const fail = (code: string) => redirect(withQuery(back, 'sso_error', code), clear);

  const origin = siteOrigin(o, req);
  if (!origin) return new Response('Unknown origin', { status: 400 });
  if (!tx || !sameString(tx.state, state)) return fail('state');
  const iss = url.searchParams.get('iss');
  if (iss && iss !== hub) return fail('issuer');
  const error = url.searchParams.get('error');
  // A quiet check (prompt=none) that found no hub session: back to the page, signed out, no error shown.
  if (error === 'login_required') return redirect(back, clear);
  if (error) return fail(/^[a-z_]{1,40}$/.test(error) ? error : 'hub_error');
  const code = url.searchParams.get('code');
  if (!code || code.length > 256) return fail('no_code');

  let claims: HubClaims;
  try {
    const r = await (o.fetch ?? fetch)(`${hub}/token`, {
      method: 'POST',
      redirect: 'error', // the code and verifier go to the hub only, never to wherever a redirect points
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: tx.verifier,
        client_id: o.clientId,
        redirect_uri: origin + (o.callbackPath ?? DEFAULT_CALLBACK_PATH),
      }).toString(),
    });
    if (!r.ok) return fail('exchange');
    const body = (await r.json()) as { id_token?: string };
    claims = await verifyHubToken(body.id_token, { hub, clientId: o.clientId, fetch: o.fetch, now: o.now?.() });
  } catch (e) {
    return fail(e instanceof SsoError ? e.code : 'exchange');
  }

  let extra: Record<string, unknown> = {};
  try {
    const r = await o.onSignedIn?.(claims, req);
    if (r === false) return fail('refused');
    if (r) extra = r;
  } catch {
    return fail('refused');
  }
  const t = nowS(o);
  const cookie = await sessionCookie(o, req, {
    ...extra,
    sub: claims.identityKey,
    aud: o.clientId,
    sid: claims.sid,
    ep: claims.epoch,
    tier: claims.tier,
    ...(claims.paymail ? { paymail: claims.paymail } : {}),
    ...(claims.handle ? { handle: claims.handle } : {}),
    chk: t,
    st: t,
    at: typeof claims.auth_time === 'number' ? claims.auth_time : t,
    sj: randomToken(12),
  });
  return redirect(back, [...clear, cookie]);
}

async function hubEpoch(o: SsoOptions, sid: string): Promise<{ active: boolean; epoch: number | null } | null> {
  const hub = hubOrigin(o.hub ?? DEFAULT_HUB);
  const key = `${hub} ${sid}`;
  const now = o.now?.() ?? Date.now();
  const hit = epochCache.get(key);
  if (hit && now - hit.at < (o.epochCacheSeconds ?? 300) * 1000) return hit;
  try {
    const r = await (o.fetch ?? fetch)(`${hub}/session/epoch?sid=${encodeURIComponent(sid)}`, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const b = (await r.json()) as { active?: unknown; epoch?: unknown };
    const v = { at: now, active: b.active === true, epoch: typeof b.epoch === 'number' ? b.epoch : null };
    epochCache.set(key, v);
    if (epochCache.size > 10000) epochCache.delete(epochCache.keys().next().value as string);
    return v;
  } catch {
    return null;
  }
}

/**
 * Read and check the site session on any request. Checks the HMAC, aud = clientId, expiry, and (at most every
 * epochCacheSeconds) the hub's session epoch, so "Sign out of all b*X sites" reaches this site within 5 minutes.
 * Send `setCookie` back on your response. If the hub can't be reached, a standard session carries on and is
 * re-checked next time; a high-tier session is refused until the hub answers.
 */
export async function verifySiteSession(req: Request, o: SsoOptions): Promise<VerifyResult> {
  const raw = readCookie(req.headers.get('cookie'), siteCookieName(o, req));
  if (!raw) return { session: null, setCookie: [] };
  const s = (await verifySession(raw, { secret: o.secret, now: o.now?.() })) as SiteSession | null;
  const dead = { session: null, setCookie: [clearSiteCookie(o, req)] };
  if (!s || s.aud !== o.clientId || typeof s.sid !== 'string' || typeof s.ep !== 'number' || (s.tier !== 'standard' && s.tier !== 'high')) return dead;
  if (o.revocations && typeof s.sj === 'string' && (await o.revocations.isRevoked(s.sj))) return dead;
  const t = nowS(o);
  let next: SiteSession = s;
  let changed = false;
  if (t - (s.chk ?? 0) >= (o.epochCacheSeconds ?? 300)) {
    const e = await hubEpoch(o, s.sid);
    if (!e) {
      if (s.tier === 'high') return { session: null, setCookie: [] };
    } else {
      if (!e.active || e.epoch !== s.ep) return dead;
      next = { ...next, chk: t };
      changed = true;
    }
  }
  // Sliding: a standard session seen a day after its last refresh gets a fresh 30 days.
  if (next.tier === 'standard' && t - next.iat >= 24 * 3600) changed = true;
  if (!changed) return { session: next, setCookie: [] };
  const { iat: _iat, exp: _exp, ...rest } = next;
  void _iat;
  void _exp;
  return { session: next, setCookie: [await sessionCookie(o, req, rest as SiteSessionClaims)] };
}

/**
 * The hub's logout URL ("Sign out of all b*X sites"), coming back to this origin's home page. With a logout_hint
 * (logoutHint(sid), made by this site's server from the visitor's session) the hub signs out at once; without one it
 * shows a confirm page, so a link on a foreign page can't sign anyone out of everything.
 */
export function hubLogoutUrl(o: Pick<SsoOptions, 'clientId' | 'hub'>, siteOrigin: string, hint?: string): string {
  const q = new URLSearchParams({ client_id: o.clientId, redirect_uri: new URL(siteOrigin).origin + '/' });
  if (hint) q.set('logout_hint', hint);
  return `${hubOrigin(o.hub ?? DEFAULT_HUB)}/logout?${q}`;
}

/** True when the visitor proved the wallet at the hub within the last maxAgeS seconds. */
export function isFresh(session: Pick<SiteSessionClaims, 'at'> | null | undefined, maxAgeS: number, nowMs: number = Date.now()): boolean {
  if (!session || typeof session.at !== 'number' || !(maxAgeS >= 0)) return false;
  const age = Math.floor(nowMs / 1000) - session.at;
  return age >= -30 && age <= maxAgeS;
}

/**
 * For sensitive pages: the session if the wallet sign-in at the hub is at most maxAgeS seconds old, else throws
 * SsoError('login_required'). Send the visitor to sign in again with prompt 'login' (bwx:signin with
 * detail { prompt: 'login' }), which asks the wallet afresh and refreshes auth_time.
 */
export function requireFresh<S extends Pick<SiteSessionClaims, 'at'>>(session: S | null | undefined, maxAgeS: number, nowMs: number = Date.now()): S {
  if (!session) throw new SsoError('login_required', 'Not signed in');
  if (!isFresh(session, maxAgeS, nowMs)) throw new SsoError('login_required', 'Sign in again with bWalletX to continue');
  return session;
}

const json = (body: unknown, status = 200, cookies: string[] = []) => {
  const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers: h });
};

export interface Sso {
  /** GET /sso/callback */
  callback(req: Request): Promise<Response>;
  /** GET /sso/session → { signedIn, identityKey, paymail, handle, tier, iat, exp } for the account chip. */
  session(req: Request): Promise<Response>;
  /** POST /sso/logout (this site) or /sso/logout?everywhere=1 → { ok, redirect } to the hub's logout. */
  logout(req: Request): Promise<Response>;
  /** Check the session in your own routes. */
  verify(req: Request): Promise<VerifyResult>;
  options: SsoOptions;
}

/** Route handlers for one site. */
export function createSso(o: SsoOptions): Sso {
  return {
    options: o,
    callback: (req) => handleSsoCallback(req, o),
    verify: (req) => verifySiteSession(req, o),
    async session(req) {
      const { session: s, setCookie } = await verifySiteSession(req, o);
      if (!s) return json({ signedIn: false }, 200, setCookie);
      return json(
        {
          signedIn: true,
          identityKey: s.sub,
          paymail: s.paymail ?? null,
          handle: s.handle ?? null,
          tier: s.tier,
          uid: s.uid ?? null,
          iat: s.iat,
          exp: s.exp,
          started: s.st,
          authTime: s.at ?? null,
        },
        200,
        setCookie,
      );
    },
    async logout(req) {
      if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
      const origin = new URL(req.url).origin;
      // CSRF: a cross-site form can't sign you out (browsers send Origin on POST).
      const from = req.headers.get('origin');
      if (from && from !== origin) return json({ error: 'Wrong origin' }, 403);
      const everywhere = new URL(req.url).searchParams.get('everywhere') === '1';
      // The session as signed (HMAC and expiry only: no hub round trip needed to sign out).
      const raw = readCookie(req.headers.get('cookie'), siteCookieName(o, req));
      const s = raw ? ((await verifySession(raw, { secret: o.secret, now: o.now?.() })) as SiteSession | null) : null;
      const mine = s && s.aud === o.clientId ? s : null;
      if (mine && o.revocations && typeof mine.sj === 'string') await o.revocations.revoke(mine.sj, mine.exp);
      const hint = everywhere && mine && typeof mine.sid === 'string' ? await logoutHint(mine.sid, nowS(o)) : undefined;
      return json({ ok: true, redirect: everywhere ? hubLogoutUrl(o, origin, hint) : null }, 200, [clearSiteCookie(o, req)]);
    },
  };
}

export { safeReturnTo };
