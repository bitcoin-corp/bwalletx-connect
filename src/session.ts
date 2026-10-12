/**
 * Signed session tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * WebCrypto only, so it runs in Node 20+, Vercel Edge and Cloudflare Workers.
 * There is no default secret: pass one (32+ chars) or every call throws.
 */

export interface SessionPayload {
  /** The proven identity key (lowercase hex). */
  sub: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expires at, seconds since the epoch. */
  exp: number;
  /** Your app's user id, if the identity key is linked to one. */
  uid?: string;
  handle?: string;
  paymail?: string;
  [claim: string]: unknown;
}

export const MIN_SECRET_LENGTH = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function assertSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `[@bwalletx/connect] A session secret of at least ${MIN_SECRET_LENGTH} characters is required. ` +
        'Set it in an environment variable (e.g. BWALLETX_SESSION_SECRET). There is no default.',
    );
  }
}

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, k);
  }
  return k;
}

export interface SignSessionOptions {
  secret: string;
  /** Lifetime in seconds. Default 7 days. */
  maxAge?: number;
  /** For tests. */
  now?: number;
}

/** Sign a session. `claims.sub` (identity key) is required. */
export async function signSession(
  claims: Omit<SessionPayload, 'iat' | 'exp'> & Partial<Pick<SessionPayload, 'iat' | 'exp'>>,
  opts: SignSessionOptions,
): Promise<string> {
  assertSecret(opts.secret);
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('session needs a sub (identity key)');
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const payload: SessionPayload = { ...claims, sub: claims.sub, iat, exp: iat + (opts.maxAge ?? 7 * 24 * 3600) };
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await hmacKey(opts.secret), enc.encode(body)));
  return `${body}.${b64u(sig)}`;
}

/** The payload if the token is authentic and unexpired, else null. Never throws on bad input (only on a missing secret). */
export async function verifySession(token: unknown, opts: { secret: string; now?: number }): Promise<SessionPayload | null> {
  assertSecret(opts.secret);
  if (typeof token !== 'string' || token.length > 8192) return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  try {
    const sig = unb64u(token.slice(dot + 1));
    // crypto.subtle.verify compares in constant time.
    const ok = await globalThis.crypto.subtle.verify('HMAC', await hmacKey(opts.secret), sig, enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(dec.decode(unb64u(body))) as SessionPayload;
    if (!p || typeof p.sub !== 'string' || typeof p.exp !== 'number') return null;
    if (Math.floor((opts.now ?? Date.now()) / 1000) >= p.exp) return null;
    return p;
  } catch {
    return null;
  }
}

export interface CookieOptions {
  name: string;
  maxAge: number;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  domain?: string;
}

/** A Set-Cookie header value. Always HttpOnly. */
export function serializeCookie(value: string, o: CookieOptions): string {
  const parts = [`${o.name}=${value}`, `Path=${o.path ?? '/'}`, `Max-Age=${o.maxAge}`, 'HttpOnly', `SameSite=${o.sameSite ?? 'Lax'}`];
  if (o.secure !== false) parts.push('Secure');
  if (o.domain) parts.push(`Domain=${o.domain}`);
  return parts.join('; ');
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
