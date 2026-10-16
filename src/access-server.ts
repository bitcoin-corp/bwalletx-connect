/**
 * Server side of the access protocol (docs/ACCESS-PROTOCOL.md): issue a challenge, verify the
 * wallet's response against an indexer, and re-check a granted session later.
 *
 * Fails closed: anything that cannot be confirmed is an AccessError, never a grant.
 */
import { ProtoWallet, PublicKey, Signature } from '@bsv/sdk';
import {
  ACCESS_CHALLENGE_LIFETIME_S,
  ACCESS_PROTOCOL,
  AccessError,
  MAX_HOLDING_PROOFS,
  atLeastRaw,
  canonicalJson,
  challengeBytes,
  kindFor,
  normaliseRequirement,
  parseAccessChallenge,
  tokenNeedRaw,
  type AccessChallenge,
  type AccessKind,
  type AccessRequirement,
  type AccessResponse,
} from './access.js';
import { isIdentityKey, type NonceStore } from './server.js';

// ── Resolvers ─────────────────────────────────────────────────────────────────────────────

export interface IdentityStatus {
  /** bit-sign identity level: 0 none, 1 Basic … 4 Sovereign (Veriff). */
  level: number;
  /** A live KYC credential for this identity key. */
  kyc: boolean;
}

/**
 * Where verifyAccess reads the chain and identity data. Every method THROWS when it cannot answer;
 * a throw becomes `indexer_unavailable`, never "holds nothing".
 */
export interface AccessResolver {
  /** Confirmed + unspent raw balance of `tokenId` ('bsv21:…') over these P2PKH addresses. */
  tokenBalance(tokenId: string, addresses: string[]): Promise<string>;
  /** Total supply, raw. Needed only for minBps requirements. */
  tokenSupply?(tokenId: string): Promise<string>;
  /** Identity level and KYC for a key. Needed only for identityLevel / kyc requirements. */
  identity?(identityKey: string, response: AccessResponse): Promise<IdentityStatus>;
}

type FetchLike = typeof fetch;

export interface OneSatResolverOptions {
  /** Default 'https://api.1sat.app/1sat'. */
  base?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const bare = (tokenId: string) => tokenId.replace(/^bsv21:/, '');

/** BSV-21 balances and supply from the 1Sat indexer (the one bit-sign's token rooms use). */
export function oneSatResolver(o: OneSatResolverOptions = {}): AccessResolver {
  const base = (o.base ?? 'https://api.1sat.app/1sat').replace(/\/$/, '');
  const f = o.fetch ?? globalThis.fetch;
  const t = o.timeoutMs ?? 12_000;
  const call = async (path: string, init?: RequestInit) => {
    const res = await f(`${base}${path}`, { ...init, signal: AbortSignal.timeout(t), cache: 'no-store' });
    if (!res.ok) throw new Error(`1sat ${res.status} for ${path}`);
    return res.json() as Promise<unknown>;
  };
  return {
    async tokenBalance(tokenId, addresses) {
      const sorted = [...new Set(addresses)].sort();
      let total = 0n;
      for (let i = 0; i < sorted.length; i += 100) {
        const j = (await call(`/bsv21/${bare(tokenId)}/p2pkh/balance`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sorted.slice(i, i + 100)),
        })) as { balance?: number | string } | null;
        const b = j?.balance ?? 0;
        const s = typeof b === 'number' ? String(Math.trunc(b)) : String(b).split('.')[0] || '0';
        if (!/^\d+$/.test(s)) throw new Error('1sat returned a bad balance');
        total += BigInt(s);
      }
      return total.toString();
    },
    async tokenSupply(tokenId) {
      const j = (await call(`/bsv21/${bare(tokenId)}`)) as Record<string, unknown> | null;
      const tok = ((j?.token as Record<string, unknown> | undefined) ?? j) || {};
      const v = tok.amt ?? tok.max ?? tok.supply;
      const s = v === undefined || v === null ? '' : String(v).split('.')[0];
      if (!/^\d+$/.test(s) || s === '0') throw new Error('1sat did not report a supply');
      return s;
    },
  };
}

export interface BitSignResolverOptions {
  /** Default 'https://bit-sign.online'. */
  base?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Token reads. Default: oneSatResolver(). */
  tokens?: AccessResolver;
}

/**
 * Identity level / KYC from bit-sign's POST /api/access/verify, which checks the signed response
 * itself (the user's signature is their consent to disclose those facts to this origin).
 * Token reads go to `tokens` (default the 1Sat indexer).
 */
export function bitSignResolver(o: BitSignResolverOptions = {}): AccessResolver {
  const base = (o.base ?? 'https://bit-sign.online').replace(/\/$/, '');
  const f = o.fetch ?? globalThis.fetch;
  const tokens = o.tokens ?? oneSatResolver({ fetch: f });
  return {
    tokenBalance: (id, a) => tokens.tokenBalance(id, a),
    tokenSupply: tokens.tokenSupply ? (id) => tokens.tokenSupply!(id) : undefined,
    async identity(identityKey, response) {
      const res = await f(`${base}/api/access/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response, only: 'identity' }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 12_000),
        cache: 'no-store',
      });
      const j = (await res.json().catch(() => null)) as { identityKey?: string; identity?: { level?: unknown; kyc?: unknown } } | null;
      if (!j?.identity || j.identityKey !== identityKey) throw new Error(`bit-sign ${res.status}`);
      return { level: Number(j.identity.level) || 0, kyc: j.identity.kyc === true };
    },
  };
}

// ── Challenge ─────────────────────────────────────────────────────────────────────────────

function normalOrigin(origin: string): string {
  const u = new URL(origin);
  if (u.origin === 'null' || u.origin !== origin.replace(/\/$/, '')) throw new Error(`origin must be scheme://host[:port], got ${origin}`);
  return u.origin;
}

function randomNonce(): string {
  const b = new Uint8Array(18);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CreateAccessChallengeOptions {
  /** YOUR origin from config. Never from the request. */
  origin: string;
  /** The requirement, from YOUR config. Never from the request. */
  require: AccessRequirement;
  /** A shared store (redisStore / pgStore). The same stores sign-in uses. */
  store: NonceStore;
  /** The identity key the browser says it is (optional). If given, a different signer is wrong_account. */
  identityKey?: unknown;
  /** Default: '403' when a token is required, else '401'. */
  kind?: AccessKind;
  lifetimeS?: number;
  now?: number;
}

export interface AccessChallengeResponse {
  /** The canonical JSON the wallet signs. Pass it to the wallet unchanged. */
  challenge: string;
  nonce: string;
  kind: AccessKind;
  protocolID: typeof ACCESS_PROTOCOL;
  keyID: string;
  exp: number;
}

export async function createAccessChallenge(o: CreateAccessChallengeOptions): Promise<AccessChallengeResponse> {
  const origin = normalOrigin(o.origin);
  const require = normaliseRequirement(o.require);
  let sub: string | undefined;
  if (o.identityKey !== undefined && o.identityKey !== null && o.identityKey !== '') {
    if (!isIdentityKey(o.identityKey)) throw new AccessError('bad_request', 'identityKey must be a compressed public key');
    sub = o.identityKey.toLowerCase();
  }
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const exp = iat + (o.lifetimeS ?? ACCESS_CHALLENGE_LIFETIME_S);
  const nonce = randomNonce();
  const c: AccessChallenge = { v: 1, kind: o.kind ?? kindFor(require), origin, nonce, iat, exp, sub, require };
  const challenge = canonicalJson(c);
  await o.store.put(nonce, { identityKey: sub ?? '', origin, message: challenge, expiresAt: exp * 1000 });
  return { challenge, nonce, kind: c.kind, protocolID: ACCESS_PROTOCOL, keyID: nonce, exp };
}

// ── Verify ────────────────────────────────────────────────────────────────────────────────

const isByteArray = (s: unknown): s is number[] =>
  Array.isArray(s) && s.length >= 8 && s.length <= 80 && s.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);

/** The P2PKH address a holding proof establishes, or null if the proof does not verify. */
export function verifyHoldingProof(challenge: string, p: unknown): string | null {
  const proof = p as { pubkey?: unknown; signature?: unknown } | null;
  if (!proof || typeof proof.pubkey !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(proof.pubkey) || !isByteArray(proof.signature)) return null;
  try {
    const pub = PublicKey.fromString(proof.pubkey);
    const sig = Signature.fromDER(proof.signature);
    return pub.verify(challengeBytes(challenge), sig) ? pub.toAddress() : null;
  } catch {
    return null;
  }
}

export interface VerifyAccessOptions {
  origin: string;
  /** The body the browser posted (AccessResponse). Untrusted. */
  response: unknown;
  store: NonceStore;
  resolver: AccessResolver;
  /**
   * The requirement YOUR config says this gate needs. If given, the challenge must carry exactly it
   * (defence in depth: the challenge came from your store, but configs change).
   */
  require?: AccessRequirement;
  now?: number;
}

export interface AccessGrant {
  ok: true;
  identityKey: string;
  kind: AccessKind;
  require: AccessRequirement;
  /** Proven addresses holding the token (store them to re-check later). */
  addresses: string[];
  have: { tokenRaw?: string; needRaw?: string; identityLevel?: number; kyc?: boolean };
}

/**
 * Verify a wallet's response. Returns the grant, or throws AccessError with a protocol code.
 * The nonce is consumed first, so each challenge can be tried once.
 */
export async function verifyAccess(o: VerifyAccessOptions): Promise<AccessGrant> {
  const r = o.response as Partial<AccessResponse> | null;
  if (!r || typeof r !== 'object' || r.v !== 1) throw new AccessError('bad_request', 'response must be { v: 1, challenge, identityKey, signature }');
  const c = parseAccessChallenge(r.challenge);
  const nowS = Math.floor((o.now ?? Date.now()) / 1000);

  const pending = await o.store.take(c.nonce);
  if (!pending) throw new AccessError(nowS >= c.exp ? 'expired' : 'replay');
  if (nowS >= c.exp || (o.now ?? Date.now()) > pending.expiresAt) throw new AccessError('expired');
  if (pending.message !== r.challenge) throw new AccessError('replay', 'challenge does not match the one issued');
  let origin: string;
  try {
    origin = normalOrigin(o.origin);
  } catch {
    throw new AccessError('bad_request', 'server origin is misconfigured');
  }
  if (c.origin !== origin || pending.origin !== origin) throw new AccessError('bad_request', 'origin mismatch');
  if (o.require && canonicalJson(normaliseRequirement(o.require)) !== canonicalJson(c.require)) {
    throw new AccessError('bad_request', 'challenge requirement does not match this gate');
  }

  if (!isIdentityKey(r.identityKey)) throw new AccessError('bad_request', 'identityKey must be a compressed public key');
  const identityKey = r.identityKey.toLowerCase();
  if (c.sub && c.sub !== identityKey) throw new AccessError('wrong_account');
  if (!isByteArray(r.signature)) throw new AccessError('invalid_signature');
  let valid = false;
  try {
    ({ valid } = await new ProtoWallet('anyone').verifySignature({
      protocolID: ACCESS_PROTOCOL,
      keyID: c.nonce,
      counterparty: identityKey,
      data: challengeBytes(r.challenge as string),
      signature: r.signature,
    }));
  } catch {
    valid = false; // @bsv/sdk throws on a bad signature
  }
  if (!valid) throw new AccessError('invalid_signature');

  const grant: AccessGrant = { ok: true, identityKey, kind: c.kind, require: c.require, addresses: [], have: {} };

  if (c.require.identityLevel || c.require.kyc) {
    if (!o.resolver.identity) throw new AccessError('indexer_unavailable', 'no identity resolver configured');
    let id: IdentityStatus;
    try {
      id = await o.resolver.identity(identityKey, r as AccessResponse);
    } catch (e) {
      throw new AccessError('indexer_unavailable', `identity lookup failed: ${(e as Error).message}`);
    }
    grant.have.identityLevel = id.level;
    grant.have.kyc = id.kyc;
    if (c.require.kyc && !id.kyc) throw new AccessError('kyc_required');
    if (c.require.identityLevel && id.level < c.require.identityLevel) {
      throw new AccessError('identity_level_too_low', undefined, { have: id.level, need: c.require.identityLevel });
    }
  }

  if (c.require.token) {
    const proofs = Array.isArray(r.holdings) ? r.holdings.slice(0, MAX_HOLDING_PROOFS) : [];
    const addresses = new Set<string>();
    for (const p of proofs) {
      const a = verifyHoldingProof(r.challenge as string, p);
      if (a) addresses.add(a);
    }
    grant.addresses = [...addresses].sort();
    const check = await checkTokenHolding(c.require, grant.addresses, o.resolver);
    grant.have.tokenRaw = check.have;
    grant.have.needRaw = check.need;
  }
  return grant;
}

/**
 * Re-check a token requirement over already-proven addresses (for periodic re-verification).
 * Returns { have, need } or throws AccessError('insufficient_tokens' | 'indexer_unavailable').
 */
export async function checkTokenHolding(
  require: AccessRequirement,
  addresses: string[],
  resolver: AccessResolver,
): Promise<{ have: string; need: string }> {
  const t = require.token;
  if (!t) return { have: '0', need: '0' };
  let supply: string | undefined;
  if (t.minBps) {
    if (!resolver.tokenSupply) throw new AccessError('indexer_unavailable', 'no supply resolver configured');
    try {
      supply = await resolver.tokenSupply(t.id);
    } catch (e) {
      throw new AccessError('indexer_unavailable', `supply lookup failed: ${(e as Error).message}`);
    }
  }
  const need = tokenNeedRaw(t, supply);
  if (!addresses.length) throw new AccessError('insufficient_tokens', undefined, { have: '0', need });
  let have: string;
  try {
    have = await resolver.tokenBalance(t.id, addresses);
  } catch (e) {
    throw new AccessError('indexer_unavailable', `balance lookup failed: ${(e as Error).message}`);
  }
  if (!atLeastRaw(have, need)) throw new AccessError('insufficient_tokens', undefined, { have, need });
  return { have, need };
}
