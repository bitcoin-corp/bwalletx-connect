/**
 * Next.js App Router adapter. Route handlers use standard Request/Response, so they also work in
 * any Fetch-API server (Hono, Remix, Bun, Workers).
 *
 *   // lib/bwalletx.ts
 *   export const auth = createBwalletXAuth({ origin: process.env.APP_ORIGIN!, store: pgStore({ query }) });
 *   // app/api/bwalletx/challenge/route.ts → export const POST = auth.challenge;
 *   // app/api/bwalletx/verify/route.ts    → export const POST = auth.verify;
 *   // app/api/bwalletx/logout/route.ts    → export const POST = auth.logout;
 *   // app/api/bwalletx/session/route.ts   → export const GET = auth.session;
 *   // server component: const s = await auth.getSession();
 */
import { IdentityLinkConflictError } from './link.js';
import { createChallenge, originAllowed, verifySignIn, type NonceStore } from './server.js';
import { assertSecret, readCookie, serializeCookie, signSession, verifySession, type SessionPayload } from './session.js';

export type { SessionPayload } from './session.js';

export interface VerifiedExtra {
  /** Your user id (e.g. from signInOrLink). Stored in the session as `uid`. */
  uid?: string;
  handle?: string;
  paymail?: string;
  [claim: string]: unknown;
}

export interface BwalletXAuthOptions {
  /** YOUR origin from config, e.g. "https://example.com". Never from the request. */
  origin: string;
  /** A shared nonce store: redisStore or pgStore. memoryStore only in development. */
  store: NonceStore;
  /** HMAC secret, 32+ chars. Default: process.env[secretEnv]. There is no fallback; requests throw without it. */
  secret?: string;
  /** Env var holding the secret. Default 'BWALLETX_SESSION_SECRET'. */
  secretEnv?: string;
  /** Cookie name. Default 'bwx_session'. */
  cookieName?: string;
  /** Session lifetime in seconds. Default 7 days. */
  maxAge?: number;
  /** Default: true when origin is https. */
  secureCookie?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  cookieDomain?: string;
  /**
   * Runs after the signature is verified, before the cookie is set: link to your user, look up a
   * handle. Throw IdentityLinkConflictError to answer 409; return false to refuse (403).
   */
  onVerified?: (identityKey: string, req: Request) => Promise<VerifiedExtra | void | false> | VerifiedExtra | void | false;
}

export interface BwalletXAuth {
  challenge(req: Request): Promise<Response>;
  verify(req: Request): Promise<Response>;
  logout(req: Request): Promise<Response>;
  session(req: Request): Promise<Response>;
  /** The session, or null. With no argument it reads cookies() from next/headers. */
  getSession(source?: Request | Headers | string | null): Promise<SessionPayload | null>;
  /** Make a cookie for an identity you verified yourself (e.g. after account linking elsewhere). */
  sessionCookie(claims: Omit<SessionPayload, 'iat' | 'exp'>): Promise<string>;
  clearCookie(): string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createBwalletXAuth(o: BwalletXAuthOptions): BwalletXAuth {
  if (!o.store) throw new Error('createBwalletXAuth needs a nonce store (redisStore, pgStore; memoryStore for dev)');
  const cookieName = o.cookieName ?? 'bwx_session';
  const maxAge = o.maxAge ?? 7 * 24 * 3600;
  const secure = o.secureCookie ?? o.origin.startsWith('https:');
  const secret = () => {
    const s = o.secret ?? (typeof process !== 'undefined' ? process.env?.[o.secretEnv ?? 'BWALLETX_SESSION_SECRET'] : undefined);
    assertSecret(s);
    return s;
  };
  const cookie = (v: string, age: number) => serializeCookie(v, { name: cookieName, maxAge: age, secure, sameSite: o.sameSite, domain: o.cookieDomain });
  const badOrigin = (req: Request) => !originAllowed(req.headers.get('origin'), o.origin);

  const fromSource = async (source?: Request | Headers | string | null): Promise<string | null> => {
    if (typeof source === 'string') return readCookie(source, cookieName);
    if (source instanceof Headers) return readCookie(source.get('cookie'), cookieName);
    if (source && typeof (source as Request).headers?.get === 'function') return readCookie((source as Request).headers.get('cookie'), cookieName);
    // Server components / route handlers: Next's cookies(). Imported lazily so the package does not require Next.
    const { cookies } = (await import('next/headers')) as { cookies: () => unknown };
    const jar = (await cookies()) as { get(n: string): { value: string } | undefined };
    return jar.get(cookieName)?.value ?? null;
  };

  const auth: BwalletXAuth = {
    async challenge(req) {
      secret();
      if (badOrigin(req)) return json({ error: 'origin not allowed' }, 403);
      const b = await body(req);
      try {
        return json(await createChallenge({ origin: o.origin, identityKey: b?.identityKey, store: o.store }));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    },
    async verify(req) {
      const key = secret();
      if (badOrigin(req)) return json({ error: 'origin not allowed' }, 403);
      const b = await body(req);
      const identityKey = await verifySignIn({ origin: o.origin, identityKey: b?.identityKey, nonce: b?.nonce, signature: b?.signature, store: o.store });
      if (!identityKey) return json({ error: 'sign-in failed' }, 401);
      let extra: VerifiedExtra = {};
      try {
        const r = await o.onVerified?.(identityKey, req);
        if (r === false) return json({ error: 'not allowed' }, 403);
        if (r) extra = r;
      } catch (e) {
        if (e instanceof IdentityLinkConflictError) return json({ error: e.message, code: e.code }, 409);
        throw e;
      }
      const token = await signSession({ ...extra, sub: identityKey }, { secret: key, maxAge });
      return json({ identityKey, uid: extra.uid, handle: extra.handle, paymail: extra.paymail }, 200, { 'set-cookie': cookie(token, maxAge) });
    },
    async logout(req) {
      if (badOrigin(req)) return json({ error: 'origin not allowed' }, 403);
      return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
    },
    async session(req) {
      const s = await auth.getSession(req);
      return s ? json({ identityKey: s.sub, uid: s.uid, handle: s.handle, paymail: s.paymail, exp: s.exp }) : json({ identityKey: null }, 200);
    },
    async getSession(source) {
      const key = secret();
      return verifySession(await fromSource(source), { secret: key });
    },
    async sessionCookie(claims) {
      return cookie(await signSession(claims, { secret: secret(), maxAge }), maxAge);
    },
    clearCookie: () => cookie('', 0),
  };
  return auth;
}

export { IdentityLinkConflictError, linkIdentity, signInOrLink } from './link.js';
export { memoryStore, redisStore, pgStore, pgNonceTableSql } from './server.js';
