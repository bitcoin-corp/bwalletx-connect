/**
 * b*X single sign-on: pieces shared by the browser add-on, the site server and the hub.
 * WebCrypto + fetch only (no @bsv/sdk), so it runs in browsers, Node 20+, Vercel functions and edge runtimes.
 */

export const DEFAULT_HUB = 'https://id.bwalletx.com';
export const DEFAULT_CALLBACK_PATH = '/sso/callback';
export const DEFAULT_SESSION_PATH = '/sso/session';
export const DEFAULT_LOGOUT_PATH = '/sso/logout';
/** The site's own session cookie (httpOnly, set by handleSsoCallback). */
export const SITE_COOKIE = 'bwx_site';
/** Prefix of the short-lived sign-in transaction cookie (state + PKCE verifier + returnTo), one per attempt. */
export const TX_COOKIE_PREFIX = 'bwx_sso_';
/** The event any page dispatches to open sign-in: window.dispatchEvent(new Event('bwx:signin')). */
export const SIGNIN_EVENT = 'bwx:signin';
export const GET_BWALLETX_URL = 'https://bwalletx.com/get';

/** standard: content, feeds, chat (30 days, sliding). high: money, signing, shares, admin (1 hour, then re-check). */
export type RiskTier = 'standard' | 'high';
export const TIER_SESSION_SECONDS: Record<RiskTier, number> = { standard: 30 * 24 * 3600, high: 3600 };

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
 * A returnTo that stays on this site: a path starting with one "/" (not "//" or "/\", which browsers treat as another
 * host). Anything else becomes the fallback, so a crafted link can never send the visitor elsewhere.
 */
export function safeReturnTo(v: unknown, fallback = '/'): string {
  if (typeof v !== 'string' || v.length > 2048) return fallback;
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f]/.test(v)) return fallback;
  return v;
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
