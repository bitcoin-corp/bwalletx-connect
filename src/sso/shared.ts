/**
 * b*X single sign-on: pieces shared by the browser add-on, the site server and the hub.
 * WebCrypto + fetch only (no @bsv/sdk), so it runs in browsers, Node 20+, Vercel functions and edge runtimes.
 */

export const DEFAULT_HUB = 'https://id.bwalletx.com';
export const DEFAULT_CALLBACK_PATH = '/sso/callback';
export const DEFAULT_SESSION_PATH = '/sso/session';
export const DEFAULT_LOGOUT_PATH = '/sso/logout';
/** The site's own session cookie on http://localhost (httpOnly, set by handleSsoCallback). */
export const SITE_COOKIE = 'bwx_site';
/** The site's session cookie on https: __Host- means Secure, Path=/ and no Domain, so no subdomain can set or read it. */
export const SITE_COOKIE_SECURE = '__Host-bwx_site';
/** Prefix of the short-lived sign-in transaction cookie (state + PKCE verifier + returnTo), one per attempt. */
export const TX_COOKIE_PREFIX = 'bwx_sso_';
/** The event any page dispatches to open sign-in: window.dispatchEvent(new Event('bwx:signin')). */
export const SIGNIN_EVENT = 'bwx:signin';
export const GET_BWALLETX_URL = 'https://bwalletx.com/get';

/** standard: content, feeds, chat (30 days, sliding). high: money, signing, shares, admin (1 hour, then re-check). */
export type RiskTier = 'standard' | 'high';
export const TIER_SESSION_SECONDS: Record<RiskTier, number> = { standard: 30 * 24 * 3600, high: 3600 };

/**
 * The wallet protocol the hub's sign-in signs under. Only id.bwalletx.com uses it, and bWalletX pins it to that origin
 * (it refuses the protocol anywhere else), so a site can't relay the hub's challenge to the wallet and replay the
 * signature at the hub. Sites keep using the shared [2, 'bwallet sign in'] for their own sign-ins.
 */
export const HUB_SIGNIN_PROTOCOL: [2, string] = [2, 'bwalletx id sign in'];
export const HUB_SIGNIN_PROTOCOL_NAME = 'bwalletx id sign in';
/** The only origin bWalletX accepts HUB_SIGNIN_PROTOCOL from. */
export const HUB_SIGNIN_ORIGIN = DEFAULT_HUB;

/** The text the wallet signs at the hub: "Sign in to id.bwalletx.com · challenge <nonce> · <ISO time>". */
export function hubSignInMessage(hub: string, nonce: string, issuedAt: number | Date): string {
  const iso = (typeof issuedAt === 'number' ? new Date(issuedAt) : issuedAt).toISOString();
  return `Sign in to ${new URL(hub).host} · challenge ${nonce} · ${iso}`;
}

/** Parse a hub sign-in message: { host, nonce, issuedAt } or null if it isn't exactly in that form. */
export function parseHubSignInMessage(m: unknown): { host: string; nonce: string; issuedAt: number } | null {
  if (typeof m !== 'string' || m.length > 300) return null;
  const x = /^Sign in to ([a-z0-9.-]+(?::\d{1,5})?) · challenge ([A-Za-z0-9_-]{16,64}) · (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(m);
  if (!x) return null;
  const issuedAt = Date.parse(x[3]);
  if (!Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== x[3]) return null;
  return { host: x[1], nonce: x[2], issuedAt };
}

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const randomToken = (bytes = 32): string => b64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

/** A verifier is 43–128 chars of [A-Za-z0-9-._~] (RFC 7636 §4.1). */
export const isPkceVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(v);
/** An S256 challenge is exactly 43 base64url chars. */
export const isPkceChallenge = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);

/** Compare two strings without an early exit on the first difference. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * A returnTo that stays on this site: a same-origin path, query and hash. The value is parsed against a placeholder
 * origin and must keep that origin, and its NORMALISED path may not start with "//" or "/\\" (browsers read those as
 * another host): "/..//evil.com" normalises to "//evil.com" and is refused. Backslashes and control characters are
 * refused anywhere. Anything else becomes the fallback, so a crafted link can never send the visitor elsewhere.
 */
export function safeReturnTo(v: unknown, fallback = '/'): string {
  if (typeof v !== 'string' || v.length > 2048) return fallback;
  if (!v.startsWith('/') || v.includes('\\') || /[\u0000-\u001f\u007f]/.test(v)) return fallback;
  const base = 'https://x.invalid';
  let u: URL;
  try {
    u = new URL(v, base);
  } catch {
    return fallback;
  }
  if (u.origin !== base || u.username || u.password) return fallback;
  if (u.pathname.startsWith('//') || u.pathname.startsWith('/\\')) return fallback;
  const out = u.pathname + u.search + u.hash;
  return out.startsWith('/') && !out.startsWith('//') ? out : fallback;
}

/** "Sign out of all" from a site: proves to the hub that the request comes from a site holding this hub session (sid). */
const LOGOUT_HINT_SECONDS = 300;
async function logoutDigest(sid: string, t: number): Promise<string> {
  return b64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(`bwx-logout:${sid}:${t}`))));
}
/**
 * The logout_hint a site adds to the hub's /logout link: "<t>.<base64url(SHA-256('bwx-logout:' + sid + ':' + t))>".
 * Only the hub and the site's server know a visitor's sid, so a foreign page can't make one; it lasts 5 minutes.
 */
export async function logoutHint(sid: string, nowS: number = Math.floor(Date.now() / 1000)): Promise<string> {
  return `${nowS}.${await logoutDigest(sid, nowS)}`;
}
/** The hub's check of a logout_hint against the session in its cookie. */
export async function checkLogoutHint(hint: unknown, sid: string, nowS: number = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (typeof hint !== 'string' || hint.length > 128 || !sid) return false;
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(hint);
  if (!m) return false;
  const t = Number(m[1]);
  if (t > nowS + 30 || nowS - t > LOGOUT_HINT_SECONDS) return false;
  return sameString(m[2], await logoutDigest(sid, t));
}

/** Strip a trailing slash: "https://id.bwalletx.com/" → "https://id.bwalletx.com". */
export const hubOrigin = (hub: string): string => new URL(hub).origin;

/** The sign-in transaction cookie's name for a state (one cookie per attempt, so two tabs don't clash). */
export const txCookieName = (state: string): string => TX_COOKIE_PREFIX + state.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '');

/** Transaction cookie value: state.verifier.base64url(returnTo). */
export function encodeTx(t: { state: string; verifier: string; returnTo: string }): string {
  return `${t.state}.${t.verifier}.${b64url(enc.encode(t.returnTo))}`;
}

export function decodeTx(v: string | null | undefined): { state: string; verifier: string; returnTo: string } | null {
  if (!v || v.length > 4096) return null;
  const [state, verifier, rt, extra] = v.split('.');
  if (extra !== undefined || !state || !isPkceVerifier(verifier) || rt === undefined) return null;
  try {
    return { state, verifier, returnTo: safeReturnTo(new TextDecoder().decode(fromB64url(rt))) };
  } catch {
    return null;
  }
}
