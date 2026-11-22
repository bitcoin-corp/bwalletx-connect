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
/** On https the tx cookie is __Host-bwx_sso_…, so a sibling subdomain can't plant one (cookie tossing). */
export const TX_COOKIE_PREFIX_SECURE = '__Host-bwx_sso_';
/** The event any page dispatches to open sign-in: window.dispatchEvent(new Event('bwx:signin')). */
export const SIGNIN_EVENT = 'bwx:signin';
export const GET_BWALLETX_URL = 'https://bwalletx.com/get';

/** standard: content, feeds, chat (30 days, sliding). high: money, signing, shares, admin (1 hour, then re-check). */
export type RiskTier = 'standard' | 'high';
export const TIER_SESSION_SECONDS: Record<RiskTier, number> = { standard: 30 * 24 * 3600, high: 3600 };

/**
 * Hub sign-in v2 (docs/HUB-SIGNIN-V2.md in bitcoin-corp/bwalletx-id). The wallet signs and POSTs straight to the hub
 * (HUB_SIGNIN_ORIGIN + HUB_WALLET_SIGNIN_PATH, over TLS, URL hard-coded in the wallet); the hub never accepts a
 * signature that a web page or a relay delivers.
 *
 * The protocol name starts with "admin": BRC-100 reserves those names for the wallet itself, so a wallet that follows
 * BRC-100 (wallet-toolbox's WalletPermissionsManager) refuses a website that asks for it. Nothing here makes any wallet
 * refuse it; that is the wallet's job (bWalletX from 5.2.62). Sites keep using [2, 'bwallet sign in'] for their own
 * sign-ins.
 */
export const HUB_SIGNIN_PROTOCOL: [2, string] = [2, 'admin bwalletx hub signin'];
export const HUB_SIGNIN_PROTOCOL_NAME = 'admin bwalletx hub signin';
/** The hub a wallet signs in to. Wallets hard-code it; they never take it from a link or a page. */
export const HUB_SIGNIN_ORIGIN = DEFAULT_HUB;
/** GET ?r=<request> (or ?code=<user code>) for what to show; POST the signature. */
export const HUB_WALLET_SIGNIN_PATH = '/api/wallet-signin';

/** RFC 8628 §6.1: 20 consonants, no vowels (no words), no look-alikes. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
/** "BCDF-GHJK": the code the hub page and the wallet both show. */
export const isHubUserCode = (v: unknown): v is string => typeof v === 'string' && USER_CODE_RE.test(v);
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const isHubRequestId = (v: unknown): v is string => typeof v === 'string' && REQUEST_ID_RE.test(v);

export interface HubSignInFields {
  /** The hub's origin (its host goes in the message). */
  hub: string;
  /** The pending sign-in's id (also the signature's keyID). */
  requestId: string;
  userCode: string;
  /** The site the sign-in continues to, or null for the hub itself. */
  clientId: string | null;
  /** ms since 1970. */
  issuedAt: number;
}

/**
 * The exact text the wallet signs (newline-separated, no trailing newline):
 *   bWalletX hub sign-in v2
 *   Hub: id.bwalletx.com
 *   Request: <request id>
 *   Code: BCDF-GHJK
 *   Site: <client_id or ->
 *   Issued: <ISO time>
 */
export function hubSignInMessage(f: HubSignInFields): string {
  if (!isHubRequestId(f.requestId)) throw new Error('bad request id');
  if (!isHubUserCode(f.userCode)) throw new Error('bad user code');
  if (f.clientId !== null && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(f.clientId)) throw new Error('bad client id');
  return [
    'bWalletX hub sign-in v2',
    `Hub: ${new URL(f.hub).host}`,
    `Request: ${f.requestId}`,
    `Code: ${f.userCode}`,
    `Site: ${f.clientId ?? '-'}`,
    `Issued: ${new Date(f.issuedAt).toISOString()}`,
  ].join('\n');
}

/** The fields of a v2 hub sign-in message, or null unless it is exactly in that form. */
export function parseHubSignInMessage(m: unknown): { host: string; requestId: string; userCode: string; clientId: string | null; issuedAt: number } | null {
  if (typeof m !== 'string' || m.length > 400) return null;
  const x =
    /^bWalletX hub sign-in v2\nHub: ([a-z0-9.-]+(?::\d{1,5})?)\nRequest: ([A-Za-z0-9_-]{22,64})\nCode: ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})\nSite: ([a-z0-9][a-z0-9-]{0,62}|-)\nIssued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(
      m,
    );
  if (!x) return null;
  const issuedAt = Date.parse(x[5]);
  if (!Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== x[5]) return null;
  return { host: x[1], requestId: x[2], userCode: x[3], clientId: x[4] === '-' ? null : x[4], issuedAt };
}

/** RFC 6749 §2.3.1 client_secret_basic: Basic base64(form-encoded id ":" form-encoded secret). */
export function clientBasicAuth(clientId: string, clientSecret: string): string {
  const fe = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  return 'Basic ' + btoa(`${fe(clientId)}:${fe(clientSecret)}`);
}

/** The client id and secret from an Authorization: Basic header, or null. */
export function parseClientBasicAuth(h: string | null | undefined): { clientId: string; clientSecret: string } | null {
  const m = /^Basic ([A-Za-z0-9+/=]{4,1024})$/.exec(h ?? '');
  if (!m) return null;
  try {
    const raw = atob(m[1]);
    const i = raw.indexOf(':');
    if (i < 1) return null;
    const fd = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
    return { clientId: fd(raw.slice(0, i)), clientSecret: fd(raw.slice(i + 1)) };
  } catch {
    return null;
  }
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

/** "Sign out of all" from a site: proves to the hub that this site's server sent it, for this hub session (sid). */
const LOGOUT_HINT_SECONDS = 300;
export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}
async function logoutMac(sid: string, c: ClientCredentials, t: number): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(c.clientSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(`bwx-logout:v2:${c.clientId}:${sid}:${t}`))));
}
/**
 * The logout_hint a site adds to the hub's /logout link: "<t>.<base64url(HMAC-SHA256(client secret,
 * 'bwx-logout:v2:' + client_id + ':' + sid + ':' + t))>". Only that site's server and the hub know the client secret,
 * so no one else can make one, even knowing the sid; it lasts 5 minutes.
 */
export async function logoutHint(sid: string, c: ClientCredentials, nowS: number = Math.floor(Date.now() / 1000)): Promise<string> {
  return `${nowS}.${await logoutMac(sid, c, nowS)}`;
}
/** The hub's check of a logout_hint against the session in its cookie and the client named in the request. */
export async function checkLogoutHint(hint: unknown, sid: string, c: ClientCredentials, nowS: number = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (typeof hint !== 'string' || hint.length > 128 || !sid || !c?.clientId || !c.clientSecret) return false;
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(hint);
  if (!m) return false;
  const t = Number(m[1]);
  if (t > nowS + 30 || nowS - t > LOGOUT_HINT_SECONDS) return false;
  return sameString(m[2], await logoutMac(sid, c, t));
}

/** Strip a trailing slash: "https://id.bwalletx.com/" → "https://id.bwalletx.com". */
export const hubOrigin = (hub: string): string => new URL(hub).origin;

/**
 * The sign-in transaction cookie's name for a state (one cookie per attempt, so two tabs don't clash). secure (https,
 * the default) gives the __Host- name; plain bwx_sso_… is for http://localhost only.
 */
export const txCookieName = (state: string, secure = true): string =>
  (secure ? TX_COOKIE_PREFIX_SECURE : TX_COOKIE_PREFIX) + state.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '');

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
