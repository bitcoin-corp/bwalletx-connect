/**
 * Browser side of the access protocol: ask the wallet to sign the site's challenge and prove the
 * keys holding the required token, using standard BRC-100 calls only (so any BRC-100 wallet works).
 */
import { Hash, PublicKey, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import {
  ACCESS_PROTOCOL,
  AccessError,
  MAX_HOLDING_PROOFS,
  challengeBytes,
  parseAccessChallenge,
  type AccessErrorBody,
  type AccessResponse,
  type HoldingProof,
} from './access.js';
import { connectBwalletX, type SignInOptions } from './signin.js';

/** The challenge route's answer (createAccessChallenge). */
export interface AccessChallengeLike {
  challenge: string;
}

export interface RequestAccessOptions {
  /** Ask your server for a challenge. Gets the wallet's identity key. */
  challenge: (identityKey: string) => Promise<AccessChallengeLike>;
  /** Post the signed response to your server. Throw AccessError (or return an error body) to refuse. */
  verify?: (response: AccessResponse) => Promise<unknown>;
  wallet?: WalletInterface;
  pairing?: SignInOptions['pairing'];
  discoverMs?: number;
  /** Basket holding BSV-21 outputs. Default 'bsv21' (bWalletX, 1Sat wallets). */
  tokenBasket?: string;
}

export interface RequestAccessResult {
  response: AccessResponse;
  /** Whatever `verify` returned. */
  verified?: unknown;
  wallet: WalletInterface;
}

const ONESAT: WalletProtocol = [0, 'onesat'];
const LEGACY_ONESAT: WalletProtocol = [0, 'p 1sat'];

/** Map a wallet / fetch failure to a protocol error. */
export function toAccessError(e: unknown): AccessError {
  if (e instanceof AccessError) return e;
  const err = e as { code?: string; message?: string; status?: number } | null;
  const msg = String(err?.message ?? e ?? '');
  if (err?.code === 'NOT_FOUND') return new AccessError('not_installed', msg);
  if (/reject|denied|declin|cancel|user/i.test(msg) || err?.code === 'ERR_USER_REJECTED' || err?.status === 4001) {
    return new AccessError('user_rejected', msg);
  }
  return new AccessError('bad_request', msg || 'access failed');
}

/** Read an AccessErrorBody from a server answer and throw it as AccessError. */
export function throwIfAccessError(body: unknown): void {
  const b = body as Partial<AccessErrorBody> | null;
  if (b && typeof b.error === 'string') throw new AccessError(b.error as AccessError['code'], b.message, { have: b.have, need: b.need });
}

function hash160FromP2pkh(script: string): string | null {
  const m = /^76a914([0-9a-f]{40})88ac$/i.exec(script.slice(-50));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Sign the challenge with every key that locks an output of `tokenId` in the wallet's token basket.
 * Outputs whose derivation can't be reproduced are skipped (the server counts only what is proven).
 */
export async function proveHoldings(wallet: WalletInterface, challenge: string, tokenId: string, basket = 'bsv21'): Promise<HoldingProof[]> {
  const bare = tokenId.replace(/^bsv21:/, '');
  const list = await wallet.listOutputs({ basket, include: 'locking scripts', includeCustomInstructions: true, limit: 10000 });
  const byKey = new Map<string, HoldingProof>();
  const data = challengeBytes(challenge);
  for (const out of list.outputs) {
    if (byKey.size >= MAX_HOLDING_PROOFS) break;
    let ci: { id?: string; keyID?: string; protocolID?: WalletProtocol; counterparty?: string } = {};
    try {
      ci = JSON.parse(out.customInstructions ?? '{}');
    } catch {
      continue;
    }
    if (ci.id !== bare || !ci.keyID) continue;
    const want = out.lockingScript ? hash160FromP2pkh(out.lockingScript) : null;
    const counterparty = ci.counterparty ?? 'self';
    for (const protocolID of ci.protocolID ? [ci.protocolID] : [ONESAT, LEGACY_ONESAT]) {
      const { publicKey } = await wallet.getPublicKey({ protocolID, keyID: ci.keyID, counterparty });
      const h = Utils.toHex(Hash.hash160(PublicKey.fromString(publicKey).encode(true) as number[]));
      if (want && h !== want) continue;
      const existing = byKey.get(publicKey);
      if (existing) {
        existing.outpoints!.push(out.outpoint.replace('.', '_'));
        break;
      }
      const { signature } = await wallet.createSignature({ protocolID, keyID: ci.keyID, counterparty, data });
      byKey.set(publicKey, { pubkey: publicKey, signature: Array.from(signature), outpoints: [out.outpoint.replace('.', '_')] });
      break;
    }
  }
  return [...byKey.values()];
}

/**
 * Run the whole flow: find the wallet, get a challenge, sign it, prove holdings, post to verify.
 * Throws AccessError with a protocol code on every failure.
 */
export async function requestAccess(o: RequestAccessOptions): Promise<RequestAccessResult> {
  let wallet: WalletInterface;
  try {
    ({ wallet } = await connectBwalletX({ wallet: o.wallet, pairing: o.pairing, discoverMs: o.discoverMs }));
  } catch (e) {
    throw (e as { code?: string })?.code === 'NOT_FOUND' ? new AccessError('not_installed') : toAccessError(e);
  }
  try {
    const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
    const { challenge } = await o.challenge(identityKey);
    const c = parseAccessChallenge(challenge);
    if (c.sub && c.sub !== identityKey.toLowerCase()) throw new AccessError('wrong_account');
    if (Date.now() / 1000 >= c.exp) throw new AccessError('expired');
    const { signature } = await wallet.createSignature({
      protocolID: ACCESS_PROTOCOL,
      keyID: c.nonce,
      counterparty: 'anyone',
      data: challengeBytes(challenge),
    });
    const response: AccessResponse = { v: 1, challenge, identityKey, signature: Array.from(signature) };
    if (c.require.token) response.holdings = await proveHoldings(wallet, challenge, c.require.token.id, o.tokenBasket);
    let verified: unknown;
    if (o.verify) {
      verified = await o.verify(response);
      throwIfAccessError(verified);
    }
    return { response, verified, wallet };
  } catch (e) {
    throw toAccessError(e);
  }
}
