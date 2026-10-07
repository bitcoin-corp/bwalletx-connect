import { ProtoWallet, PublicKey, type WalletProtocol } from '@bsv/sdk';

/** Security level 2, a protocol name used for nothing else. Keep it constant. */
export const LOGIN_PROTOCOL: WalletProtocol = [2, 'bwallet sign in'];
export const CHALLENGE_LIFETIME_MS = 2 * 60 * 1000;

export interface PendingChallenge {
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
  if (!opts.quiet && !warned) {
    warned = true;
    console.warn('[@bwalletx/connect] Using the in-memory nonce store. It is for development only; pass a shared store (Redis, database) in production.');
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
  /** The identity key the browser claims. Checked again at verify. */
  identityKey: unknown;
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

/** Step 1. Throws if identityKey is not a valid compressed public key. Send the result to the browser. */
export async function createChallenge(opts: CreateChallengeOptions): Promise<ChallengeResponse> {
  if (!isIdentityKey(opts.identityKey)) throw new Error('identityKey must be a compressed public key (66 hex chars)');
  const origin = normalOrigin(opts.origin);
  const nonce = randomNonce();
  const expiresAt = Date.now() + CHALLENGE_LIFETIME_MS;
  const message = loginMessage(origin, nonce, expiresAt);
  await storeOrDefault(opts.store).put(nonce, { identityKey: opts.identityKey.toLowerCase(), origin, message, expiresAt });
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
  if (c.identityKey !== identityKey) return null;

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
