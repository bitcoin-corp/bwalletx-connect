import type { WalletInterface, WalletProtocol } from '@bsv/sdk';
import { discoverBwalletX } from './discover.js';
import { pairBwalletX, restorePairing, type PairingOptions } from './pair.js';

/** Security level 2, a protocol name used for nothing else. */
export const LOGIN_PROTOCOL: WalletProtocol = [2, 'bwallet sign in'];

/** What your server's challenge route returns (createChallenge from '@bwalletx/connect/server'). */
export interface Challenge {
  nonce: string;
  message: string;
  keyID: string;
  protocolID?: WalletProtocol;
}

export type SignInMethod = 'extension' | 'in-app' | 'pairing' | 'wallet';

export interface SignInOptions {
  /** Ask your server for a challenge for this identity key. */
  challenge: (identityKey: string) => Promise<Challenge>;
  /** Use this wallet instead of looking for one. `method` is then 'wallet'. */
  wallet?: WalletInterface;
  /** How to show the QR and code if pairing is needed. Without it, pairing is not tried. */
  pairing?: PairingOptions;
  /** Reuse a pairing stored by an earlier sign-in before showing a new QR. Default true. */
  reusePairing?: boolean;
  /** How long to wait for the extension or in-app browser to answer, in ms. Default 1200. */
  discoverMs?: number;
}

export interface SignInResult {
  identityKey: string;
  /** DER signature as number[], ready to post to verifySignIn. */
  signature: number[];
  nonce: string;
  method: SignInMethod;
  /** The wallet that signed. Keep it to make more calls. */
  wallet: WalletInterface;
}

/** Find a wallet: extension or in-app browser first, then a stored pairing, then a new pairing. */
export async function connectBwalletX(
  opts: Pick<SignInOptions, 'wallet' | 'pairing' | 'reusePairing' | 'discoverMs'> = {},
): Promise<{ wallet: WalletInterface; method: SignInMethod }> {
  if (opts.wallet) return { wallet: opts.wallet, method: 'wallet' };
  const found = await discoverBwalletX(opts.discoverMs);
  if (found) return { wallet: found.wallet, method: found.method };
  if (opts.reusePairing !== false) {
    const restored = await restorePairing(opts.pairing ?? {});
    if (restored) return { wallet: restored, method: 'pairing' };
  }
  if (!opts.pairing) {
    throw Object.assign(new Error('bWalletX was not found in this browser'), { code: 'NOT_FOUND' });
  }
  return { wallet: await pairBwalletX(opts.pairing), method: 'pairing' };
}

/**
 * Sign the server's challenge with the user's bWalletX identity key. Post the result's
 * identityKey, nonce and signature to your verify route.
 */
export async function signInWithBwalletX(opts: SignInOptions): Promise<SignInResult> {
  const { wallet, method } = await connectBwalletX(opts);
  if (method !== 'pairing') await wallet.waitForAuthentication({}).catch(() => {});
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
  const c = await opts.challenge(identityKey);
  const { signature } = await wallet.createSignature({
    protocolID: c.protocolID ?? LOGIN_PROTOCOL,
    keyID: c.keyID,
    counterparty: 'anyone',
    data: Array.from(new TextEncoder().encode(c.message)),
  });
  return { identityKey, signature: Array.from(signature), nonce: c.nonce, method, wallet };
}
