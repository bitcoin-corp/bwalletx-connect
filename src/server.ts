import { PrivateKey, ProtoWallet, PublicKey, Utils, type WalletProtocol } from '@bsv/sdk';
import { BROWSER_HINTS, QR_LIFETIME_S, RID_RE, pairProofText, pairProofTextV2 } from './protocol.js';

/** Security level 2, a protocol name used for nothing else. Keep it constant. */
export const LOGIN_PROTOCOL: WalletProtocol = [2, 'bwallet sign in'];
export const CHALLENGE_LIFETIME_MS = 2 * 60 * 1000;

export interface PendingChallenge {
  /** The key the challenge was made for, or '' when none was given (verifySignIn then binds the claimed key). */
  identityKey: string;
  origin: string;
  message: string;
  expiresAt: number;
}

/**
 * Where challenges wait between the two routes. Use Redis or a database table in production.
 * `take` must read and delete in one step, so each nonce can be tried once.
 */
export interface NonceStore {
  put(nonce: string, c: PendingChallenge): Promise<void> | void;
  take(nonce: string): Promise<PendingChallenge | null> | PendingChallenge | null;
}

let warned = false;

/**
 * In-memory store. For development and tests only: it is lost on restart and not shared between
 * server processes or serverless instances. Expired entries are pruned on each put.
 */
export function memoryStore(opts: { quiet?: boolean } = {}): NonceStore {
  const prod = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
  if ((prod || !opts.quiet) && !warned) {
    warned = true;
    console.warn(
      prod
        ? '[@bwalletx/connect] WARNING: the in-memory nonce store is running in production. It is not shared between instances and breaks on serverless. Use redisStore or pgStore.'
        : '[@bwalletx/connect] Using the in-memory nonce store. It is for development only; pass a shared store (redisStore, pgStore) in production.',
    );
  }
  const m = new Map<string, PendingChallenge>();
  return {
    put(nonce, c) {
      const now = Date.now();
      for (const [k, v] of m) if (v.expiresAt < now) m.delete(k);
      m.set(nonce, c);
    },
    take(nonce) {
      const c = m.get(nonce) ?? null;
      m.delete(nonce);
      return c;
    },
  };
}

let defaultStore: NonceStore | null = null;
const storeOrDefault = (s?: NonceStore) => s ?? (defaultStore ??= memoryStore());

export function isIdentityKey(x: unknown): x is string {
  if (typeof x !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(x)) return false;
  try {
    PublicKey.fromString(x);
    return true;
  } catch {
    return false;
  }
}

function normalOrigin(origin: string): string {
  const u = new URL(origin);
  if (u.origin === 'null' || u.origin !== origin.replace(/\/$/, '')) {
    throw new Error(`origin must be scheme://host[:port], got ${origin}`);
  }
  return u.origin;
}

/** The text the user signs. Lines joined with \n, no trailing newline. */
export function loginMessage(origin: string, nonce: string, expiresAt: number): string {
  return [
    `Sign in to ${new URL(origin).host} with bWallet`,
    '',
    'This proves you hold this wallet. It does not spend anything.',
    '',
    `Origin: ${origin}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
  ].join('\n');
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CreateChallengeOptions {
  /** YOUR site's origin from config, e.g. "https://example.com". Never take it from the request. */
  origin: string;
  /**
   * The identity key the browser claims, checked again at verify. Optional since 0.5.5: leave it out so the browser
   * can ask the wallet for the key and the signature in ONE sheet; verifySignIn then binds the key the browser claims,
   * and the signature only verifies for that key. A challenge made WITH a key still only verifies for that key.
   */
  identityKey?: unknown;
  /** Default: a process-wide in-memory store (dev only). */
  store?: NonceStore;
}

export interface ChallengeResponse {
  nonce: string;
  message: string;
  protocolID: WalletProtocol;
  keyID: string;
  expiresAt: number;
}

/** Step 1. Throws if an identityKey is given and is not a valid compressed public key. Send the result to the browser. */
export async function createChallenge(opts: CreateChallengeOptions): Promise<ChallengeResponse> {
  const given = opts.identityKey !== undefined && opts.identityKey !== null && opts.identityKey !== '';
  if (given && !isIdentityKey(opts.identityKey)) throw new Error('identityKey must be a compressed public key (66 hex chars)');
  const boundKey = given ? (opts.identityKey as string).toLowerCase() : '';
  const origin = normalOrigin(opts.origin);
  const nonce = randomNonce();
  const expiresAt = Date.now() + CHALLENGE_LIFETIME_MS;
  const message = loginMessage(origin, nonce, expiresAt);
  await storeOrDefault(opts.store).put(nonce, { identityKey: boundKey, origin, message, expiresAt });
  return { nonce, message, protocolID: LOGIN_PROTOCOL, keyID: nonce, expiresAt };
}

export interface VerifySignInOptions {
  /** YOUR site's origin from config. Must equal the origin the challenge was made for. */
  origin: string;
  /** From the request body. */
  identityKey: unknown;
  nonce: unknown;
  signature: unknown;
  store?: NonceStore;
}

/**
 * Step 2. Returns the proven identity key (lowercase hex), or null.
 * The nonce is deleted before anything is checked, so each challenge can be tried once.
 */
export async function verifySignIn(opts: VerifySignInOptions): Promise<string | null> {
  if (typeof opts.nonce !== 'string' || opts.nonce.length > 64) return null;
  const c = await storeOrDefault(opts.store).take(opts.nonce);
  if (!c || Date.now() > c.expiresAt) return null;
  let origin: string;
  try {
    origin = normalOrigin(opts.origin);
  } catch {
    return null;
  }
  if (c.origin !== origin) return null;
  if (!isIdentityKey(opts.identityKey)) return null;
  const identityKey = opts.identityKey.toLowerCase();
  // A challenge made for a key only verifies for that key. One made without a key binds the key claimed now: the
  // signature below is checked against exactly this key, so a wrong claim fails.
  if (c.identityKey && c.identityKey !== identityKey) return null;

  const sig = opts.signature;
  if (!Array.isArray(sig) || sig.length < 8 || sig.length > 80 || !sig.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return null;
  }
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      protocolID: LOGIN_PROTOCOL,
      keyID: opts.nonce,
      counterparty: identityKey,
      data: Array.from(new TextEncoder().encode(c.message)),
      signature: sig as number[],
    });
    return valid ? identityKey : null;
  } catch {
    return null; // @bsv/sdk throws on a bad signature instead of returning valid: false
  }
}

/** True when a request's Origin header is exactly your configured origin. Check it on both routes. */
export function originAllowed(requestOrigin: string | null | undefined, origin: string): boolean {
  try {
    return !!requestOrigin && requestOrigin === normalOrigin(origin);
  } catch {
    return false;
  }
}

export { redisStore, pgStore, pgNonceTableSql } from './nonce-stores.js';
export type { RedisLike, RedisStoreOptions, PgQuery, PgStoreOptions } from './nonce-stores.js';
export { signSession, verifySession, serializeCookie, readCookie, MIN_SECRET_LENGTH } from './session.js';
export type { SessionPayload, SignSessionOptions, CookieOptions } from './session.js';
export { verifyPayment, PaymentVerificationError } from './verify-payment.js';
export type { VerifyPaymentOptions, VerifyPaymentResult, ExpectedOutput, TxStatus } from './verify-payment.js';
export { linkIdentity, signInOrLink, IdentityLinkConflictError } from './link.js';
export type { LinkCallbacks, LinkResult, SignInOrLinkOptions, SignInOrLinkResult } from './link.js';
export * from './access.js';
export { createAccessChallenge, verifyAccess, verifyHoldingProof, checkTokenHolding, oneSatResolver, bitSignResolver } from './access-server.js';
export type { AccessResolver, IdentityStatus, OneSatResolverOptions, BitSignResolverOptions, CreateAccessChallengeOptions, AccessChallengeResponse, VerifyAccessOptions, AccessGrant } from './access-server.js';


/** What the browser sends to your pair-proof route (pairingModal({ proofUrl })). */
export interface PairProofRequest {
  c: string;
  k: string;
  o: string;
  e: number;
  ret?: string;
  rid?: string;
  b?: string;
}

/**
 * (0.9.0) Sign a pairing link for THIS origin with your site's pairing key, so bWalletX shows your host as proven and
 * (5.2.61+) folds the sign-in into Connect. Publish the key's public half at /.well-known/bwalletx-pair.json
 * (pairKeysDocument). Signs only: `o` equal to `origin`, a live expiry (at most the QR lifetime + 60 s ahead), and a
 * `ret` that is exactly this origin's root. Returns null for anything else.
 *
 * Limits: a script outside a browser can call your route too and get a proof for its own channel, so a proof says "this
 * site's server issued this link", not "this is the site's page". It stops other web pages (browsers set Origin
 * honestly, and your route checks it), not a determined attacker with a server.
 */
export function signPairProofs(
  r: PairProofRequest,
  o: { origin: string; key: PrivateKey | string; nowS?: number },
): { s: string; s2?: string } | null {
  const nowS = o.nowS ?? Math.floor(Date.now() / 1000);
  let key: PrivateKey;
  try {
    key = typeof o.key === 'string' ? (/^[0-9a-f]{64}$/i.test(o.key) ? new PrivateKey(o.key, 'hex') : PrivateKey.fromWif(o.key)) : o.key;
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object') return null;
  if (typeof r.c !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(r.c)) return null;
  if (typeof r.k !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(r.k)) return null;
  if (r.o !== new URL(o.origin).origin) return null;
  if (!Number.isInteger(r.e) || r.e < nowS || r.e > nowS + QR_LIFETIME_S + 60) return null;
  const sign = (text: string) => Utils.toHex(key.sign(Utils.toArray(text, 'utf8')).toDER() as number[]);
  const out: { s: string; s2?: string } = { s: sign(pairProofText(r)) };
  if (r.ret !== undefined || r.rid !== undefined) {
    if (r.ret !== `${r.o}/` || typeof r.rid !== 'string' || !RID_RE.test(r.rid)) return null;
    if (r.b !== undefined && !(BROWSER_HINTS as readonly string[]).includes(r.b)) return null;
    out.s2 = sign(pairProofTextV2({ ...r, ret: r.ret, rid: r.rid }));
  }
  return out;
}

/** The body of /.well-known/bwalletx-pair.json: up to 8 compressed public keys (the current one first). */
export function pairKeysDocument(keys: (PrivateKey | string)[]): { keys: string[] } {
  const out: string[] = [];
  for (const k of keys) {
    try {
      const pub = typeof k === 'string' ? (/^0[23][0-9a-f]{64}$/i.test(k) ? k.toLowerCase() : PrivateKey.fromWif(k).toPublicKey().toString()) : k.toPublicKey().toString();
      if (!out.includes(pub)) out.push(pub);
    } catch {
      /* skip a malformed key */
    }
  }
  return { keys: out.slice(0, 8) };
}
