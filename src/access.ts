/**
 * $401 / $402 / $403 access protocol, version 1. Shared by sites (client + server) and wallets.
 * The full spec is docs/ACCESS-PROTOCOL.md. Pure: no I/O, @bsv/sdk types only.
 *
 *   401 identity  "prove who you are (at identity level N, or KYC'd)"
 *   402 payment   "pay for this" (the challenge format is reserved; payment itself uses pay())
 *   403 access    "prove you hold N of token X (or N basis points of its supply)"
 */
import type { WalletProtocol } from '@bsv/sdk';

export const ACCESS_VERSION = 1 as const;
/** Security level 2, a protocol name used for nothing else. Wallets recognise it and show the kind's video. */
export const ACCESS_PROTOCOL: WalletProtocol = [2, 'bwalletx access'];
/** How long a challenge is valid. */
export const ACCESS_CHALLENGE_LIFETIME_S = 120;
/** At most this many holding proofs are read from one response. */
export const MAX_HOLDING_PROOFS = 50;

export type AccessKind = '401' | '402' | '403';

export interface TokenRequirement {
  /** 'bsv21:<txid>_<vout>' */
  id: string;
  /** Minimum raw (unscaled, integer string) amount. */
  min?: string;
  /** Minimum in basis points of total supply (1 = 0.01%, 10000 = 100%). */
  minBps?: number;
}

export interface AccessRequirement {
  token?: TokenRequirement;
  /** $401 identity level (bit-sign strands): 1 Basic, 2 Verified, 3 Strong, 4 Sovereign (Veriff). */
  identityLevel?: number;
  /** A live KYC credential is required. */
  kyc?: boolean;
}

/** What the wallet signs, as canonical JSON. Times are seconds since the epoch. */
export interface AccessChallenge {
  v: 1;
  kind: AccessKind;
  origin: string;
  nonce: string;
  iat: number;
  exp: number;
  /** The identity key the site expects. A different wallet account is `wrong_account`. */
  sub?: string;
  require: AccessRequirement;
}

/** A key that locks some of the required token, proving control by signing the same challenge bytes. */
export interface HoldingProof {
  /** Compressed public key hex of the key locking the outputs. */
  pubkey: string;
  /** DER signature by that key over SHA-256(challenge bytes), as BRC-100 createSignature returns. */
  signature: number[];
  /** Optional hint: outpoints ('txid_vout') this key holds. Servers must not trust it. */
  outpoints?: string[];
}

/** What the wallet (via requestAccess) posts back to the site. */
export interface AccessResponse {
  v: 1;
  /** The challenge string exactly as issued. */
  challenge: string;
  identityKey: string;
  /** DER signature: createSignature({ protocolID: ACCESS_PROTOCOL, keyID: nonce, counterparty: 'anyone', data: challenge bytes }). */
  signature: number[];
  holdings?: HoldingProof[];
}

export type AccessErrorCode =
  | 'not_installed'
  | 'user_rejected'
  | 'wrong_account'
  | 'insufficient_tokens'
  | 'identity_level_too_low'
  | 'kyc_required'
  | 'indexer_unavailable'
  | 'expired'
  | 'replay'
  | 'invalid_signature'
  | 'bad_request';

/** The HTTP status a site should answer each code with. */
export const ACCESS_ERROR_STATUS: Record<AccessErrorCode, number> = {
  not_installed: 424,
  user_rejected: 403,
  wrong_account: 409,
  insufficient_tokens: 403,
  identity_level_too_low: 403,
  kyc_required: 403,
  indexer_unavailable: 503,
  expired: 401,
  replay: 401,
  invalid_signature: 401,
  bad_request: 400,
};

export interface AccessErrorBody {
  error: AccessErrorCode;
  message: string;
  /** insufficient_tokens: raw amounts; identity_level_too_low: levels. */
  have?: string | number;
  need?: string | number;
}

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  readonly have?: string | number;
  readonly need?: string | number;
  constructor(code: AccessErrorCode, message?: string, extra: { have?: string | number; need?: string | number } = {}) {
    super(message ?? code);
    this.name = 'AccessError';
    this.code = code;
    this.have = extra.have;
    this.need = extra.need;
  }
  toJSON(): AccessErrorBody {
    const b: AccessErrorBody = { error: this.code, message: this.message };
    if (this.have !== undefined) b.have = this.have;
    if (this.need !== undefined) b.need = this.need;
    return b;
  }
}

/** One video + poster + colour per kind, so wallets and sites show the same thing. Paths are inside the package. */
export const PROTOCOL_MEDIA: Record<AccessKind, { name: string; color: string; video: string; poster: string }> = {
  '401': { name: 'Identity', color: '#22c55e', video: 'assets/protocol/401.mp4', poster: 'assets/protocol/401.jpg' },
  '402': { name: 'Payment', color: '#3b82f6', video: 'assets/protocol/402.mp4', poster: 'assets/protocol/402.jpg' },
  '403': { name: 'Access', color: '#ef4444', video: 'assets/protocol/403.mp4', poster: 'assets/protocol/403.jpg' },
};

/** Media URLs on a CDN (unpkg) for a given package version. */
export function protocolMediaUrl(kind: AccessKind, which: 'video' | 'poster', version = 'latest'): string {
  return `https://unpkg.com/@bwalletx/connect@${version}/${PROTOCOL_MEDIA[kind][which]}`;
}

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, undefined members dropped.
 * Only strings, finite numbers, booleans, null, arrays and plain objects are allowed.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof v}`);
}

/** The bytes every signature in the protocol covers: UTF-8 of the challenge string. */
export function challengeBytes(challenge: string): number[] {
  return Array.from(new TextEncoder().encode(challenge));
}

const TOKEN_ID = /^bsv21:[0-9a-f]{64}_\d{1,6}$/;
const RAW = /^[1-9]\d{0,38}$/;

/** Throws AccessError('bad_request') if the requirement is malformed. Returns a normalised copy. */
export function normaliseRequirement(r: unknown): AccessRequirement {
  if (!r || typeof r !== 'object') throw new AccessError('bad_request', 'require must be an object');
  const req = r as Record<string, unknown>;
  const out: AccessRequirement = {};
  if (req.token !== undefined) {
    const t = req.token as Record<string, unknown>;
    if (!t || typeof t !== 'object' || typeof t.id !== 'string') throw new AccessError('bad_request', 'require.token.id is required');
    const id = t.id.trim().toLowerCase();
    if (!TOKEN_ID.test(id)) throw new AccessError('bad_request', "require.token.id must be 'bsv21:<txid>_<vout>'");
    const hasMin = t.min !== undefined;
    const hasBps = t.minBps !== undefined;
    if (hasMin === hasBps) throw new AccessError('bad_request', 'require.token needs exactly one of min or minBps');
    out.token = { id };
    if (hasMin) {
      if (typeof t.min !== 'string' || !RAW.test(t.min)) throw new AccessError('bad_request', 'require.token.min must be a positive integer string (raw units)');
      out.token.min = t.min;
    } else {
      if (!Number.isInteger(t.minBps) || (t.minBps as number) < 1 || (t.minBps as number) > 10000) {
        throw new AccessError('bad_request', 'require.token.minBps must be an integer 1..10000');
      }
      out.token.minBps = t.minBps as number;
    }
  }
  if (req.identityLevel !== undefined) {
    if (!Number.isInteger(req.identityLevel) || (req.identityLevel as number) < 1 || (req.identityLevel as number) > 10) {
      throw new AccessError('bad_request', 'require.identityLevel must be an integer 1..10');
    }
    out.identityLevel = req.identityLevel as number;
  }
  if (req.kyc !== undefined) {
    if (typeof req.kyc !== 'boolean') throw new AccessError('bad_request', 'require.kyc must be a boolean');
    if (req.kyc) out.kyc = true;
  }
  if (!out.token && !out.identityLevel && !out.kyc) throw new AccessError('bad_request', 'require is empty');
  return out;
}

/** The kind a requirement implies: any token → 403; otherwise 401. */
export function kindFor(r: AccessRequirement): AccessKind {
  return r.token ? '403' : '401';
}

/** Parse and validate a challenge string. Throws AccessError('bad_request'). Does not check expiry. */
export function parseAccessChallenge(s: unknown): AccessChallenge {
  if (typeof s !== 'string' || s.length > 4096) throw new AccessError('bad_request', 'challenge must be a string');
  let c: AccessChallenge;
  try {
    c = JSON.parse(s) as AccessChallenge;
  } catch {
    throw new AccessError('bad_request', 'challenge is not JSON');
  }
  if (!c || typeof c !== 'object' || c.v !== 1) throw new AccessError('bad_request', 'unsupported challenge version');
  if (c.kind !== '401' && c.kind !== '402' && c.kind !== '403') throw new AccessError('bad_request', 'bad kind');
  if (typeof c.origin !== 'string' || typeof c.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(c.nonce)) {
    throw new AccessError('bad_request', 'bad origin or nonce');
  }
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.exp <= c.iat) throw new AccessError('bad_request', 'bad iat/exp');
  if (c.sub !== undefined && (typeof c.sub !== 'string' || !/^0[23][0-9a-f]{64}$/.test(c.sub))) throw new AccessError('bad_request', 'bad sub');
  c.require = normaliseRequirement(c.require);
  if (canonicalJson(c) !== s) throw new AccessError('bad_request', 'challenge is not canonical');
  return c;
}

/** Raw amount needed for a token requirement, given total supply (needed only for minBps). Rounds up. */
export function tokenNeedRaw(t: TokenRequirement, supplyRaw?: string): string {
  if (t.min) return t.min;
  if (supplyRaw === undefined || !/^\d+$/.test(supplyRaw)) throw new AccessError('indexer_unavailable', 'token supply unknown');
  const n = BigInt(supplyRaw) * BigInt(t.minBps!);
  const need = (n + 9999n) / 10000n;
  return (need < 1n ? 1n : need).toString();
}

/** Compare unscaled integer strings. Fails closed on malformed input. */
export function atLeastRaw(have: string, need: string): boolean {
  try {
    return BigInt(have) >= BigInt(need);
  } catch {
    return false;
  }
}

/** A user-readable line for an error code. */
export function accessErrorMessage(code: AccessErrorCode, e: { have?: string | number; need?: string | number } = {}): string {
  switch (code) {
    case 'not_installed': return 'No bWalletX (or other BRC-100 wallet) was found.';
    case 'user_rejected': return 'The request was declined in the wallet.';
    case 'wrong_account': return 'The wallet is signed in to a different account than this site expects.';
    case 'insufficient_tokens': return `Not enough tokens: holding ${e.have ?? 0}, need ${e.need ?? '?'}.`;
    case 'identity_level_too_low': return `Identity level ${e.have ?? 0} is below the required level ${e.need ?? '?'}.`;
    case 'kyc_required': return 'A verified identity (KYC) is required.';
    case 'indexer_unavailable': return 'Holdings could not be checked right now. Try again shortly.';
    case 'expired': return 'The request expired. Try again.';
    case 'replay': return 'That request was already used. Try again.';
    case 'invalid_signature': return 'The wallet signature did not verify.';
    case 'bad_request': return 'The request was malformed.';
  }
}
