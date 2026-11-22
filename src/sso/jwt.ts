/**
 * Verify the hub's ID tokens: ES256 JWTs, keys from the hub's JWKS (/.well-known/jwks.json).
 * Only ES256 is accepted (no "none", no HMAC), so a token can't pick a weaker algorithm.
 */
import { fromB64url, hubOrigin } from './shared.js';

export interface HubJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg?: string;
  use?: string;
}

/** Claims in a hub ID token. */
export interface HubClaims {
  iss: string;
  /** The identity key (same as identityKey). */
  sub: string;
  /** The client_id this token is for. */
  aud: string;
  iat: number;
  exp: number;
  /** The hub session id: ask /session/epoch?sid= whether it is still signed in. */
  sid: string;
  /** The identity's session epoch when signed in. A bigger epoch at the hub means "signed out everywhere". */
  epoch: number;
  identityKey: string;
  paymail: string | null;
  handle: string | null;
  tier: 'standard' | 'high';
  auth_time: number;
  jti: string;
}

export class SsoError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SsoError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const JWKS_TTL_MS = 5 * 60 * 1000;
const REFETCH_GAP_MS = 30 * 1000;
const cache = new Map<string, { at: number; keys: Map<string, Promise<CryptoKey>> }>();

/** Forget cached JWKS (tests, or after a key rotation you know about). */
export function clearJwksCache(): void {
  cache.clear();
}

async function loadJwks(hub: string, f: FetchLike): Promise<Map<string, Promise<CryptoKey>>> {
  const r = await f(`${hub}/.well-known/jwks.json`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new SsoError('jwks_unavailable', `The sign-in hub's keys could not be read (${r.status})`);
  const body = (await r.json()) as { keys?: HubJwk[] };
  const keys = new Map<string, Promise<CryptoKey>>();
  for (const k of body.keys ?? []) {
    if (k?.kty !== 'EC' || k.crv !== 'P-256' || typeof k.kid !== 'string' || typeof k.x !== 'string' || typeof k.y !== 'string') continue;
    keys.set(
      k.kid,
      globalThis.crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: k.x, y: k.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']),
    );
  }
  return keys;
}

async function keyFor(hub: string, kid: string, f: FetchLike, now: number): Promise<CryptoKey | null> {
  let c = cache.get(hub);
  if (!c || now - c.at > JWKS_TTL_MS) {
    c = { at: now, keys: await loadJwks(hub, f) };
    cache.set(hub, c);
  } else if (!c.keys.has(kid) && now - c.at > REFETCH_GAP_MS) {
    // An unknown kid may be a key the hub just rotated in: refetch, but not more than every 30 s.
    c = { at: now, keys: await loadJwks(hub, f) };
    cache.set(hub, c);
  }
  const k = c.keys.get(kid);
  return k ? await k : null;
}

export interface VerifyHubTokenOptions {
  /** The hub, e.g. "https://id.bwalletx.com". Its origin must equal the token's iss. */
  hub: string;
  /** Your client_id. The token's aud must equal it exactly. */
  clientId: string;
  fetch?: FetchLike;
  /** ms since the epoch, for tests. */
  now?: number;
  /** Allowed clock skew, seconds. Default 30. */
  skew?: number;
}

/** The token's claims if the signature, iss, aud and times all check out. Throws SsoError otherwise. */
export async function verifyHubToken(token: unknown, o: VerifyHubTokenOptions): Promise<HubClaims> {
  const now = o.now ?? Date.now();
  const skew = o.skew ?? 30;
  const iss = hubOrigin(o.hub);
  if (typeof token !== 'string' || token.length > 8192) throw new SsoError('bad_token', 'No token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new SsoError('bad_token', 'Malformed token');
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: HubClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    throw new SsoError('bad_token', 'Malformed token');
  }
  if (header.alg !== 'ES256') throw new SsoError('bad_alg', 'Only ES256 tokens are accepted');
  if (typeof header.kid !== 'string' || !header.kid) throw new SsoError('bad_token', 'Token has no key id');
  const key = await keyFor(iss, header.kid, o.fetch ?? fetch, now);
  if (!key) throw new SsoError('unknown_key', 'Token signed by a key the hub does not list');
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromB64url(parts[2]);
  } catch {
    throw new SsoError('bad_signature', 'Bad signature');
  }
  const ok =
    sig.length === 64 &&
    (await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)));
  if (!ok) throw new SsoError('bad_signature', 'Bad signature');
  const t = Math.floor(now / 1000);
  if (!claims || typeof claims !== 'object') throw new SsoError('bad_token', 'Malformed token');
  if (claims.iss !== iss) throw new SsoError('bad_iss', 'Token is from another issuer');
  if (claims.aud !== o.clientId) throw new SsoError('bad_aud', 'Token is for another site');
  if (typeof claims.exp !== 'number' || t > claims.exp + skew) throw new SsoError('expired', 'Token has expired');
  if (typeof claims.iat !== 'number' || claims.iat > t + skew) throw new SsoError('bad_token', 'Token issued in the future');
  if (typeof claims.sub !== 'string' || !/^0[23][0-9a-f]{64}$/.test(claims.sub)) throw new SsoError('bad_token', 'Token has no identity key');
  if (typeof claims.sid !== 'string' || !claims.sid) throw new SsoError('bad_token', 'Token has no session id');
  if (typeof claims.epoch !== 'number') throw new SsoError('bad_token', 'Token has no session epoch');
  if (claims.tier !== 'standard' && claims.tier !== 'high') throw new SsoError('bad_token', 'Token has no risk tier');
  return { ...claims, identityKey: claims.sub };
}
