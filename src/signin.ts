import type { WalletInterface, WalletProtocol } from '@bsv/sdk';
import { discoverBwalletX, DEFAULT_DISCOVER_MS } from './discover.js';
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

/**
 * Progress for the button label. 'finding': looking for a wallet (sub-second); 'opening': a wallet was found and its
 * approval is on the way ("Opening your wallet…"); 'pairing': no wallet in this browser, the QR is showing;
 * 'signing': the identity key arrived, the sign-in signature is being asked for.
 */
export type SignInStatus = 'finding' | 'opening' | 'pairing' | 'signing';

export interface SignInOptions {
  /** Ask your server for a challenge for this identity key. */
  challenge: (identityKey: string) => Promise<Challenge>;
  /** Use this wallet instead of looking for one. `method` is then 'wallet'. */
  wallet?: WalletInterface;
  /** How to show the QR and code if pairing is needed. Without it, pairing is not tried. */
  pairing?: PairingOptions;
  /** Reuse a pairing stored by an earlier sign-in before showing a new QR. Default true. */
  reusePairing?: boolean;
  /** How long to wait for a wallet that has not answered, in ms, before pairing. Default 300 (a present wallet answers at once). */
  discoverMs?: number;
  /** Called as the sign-in moves on, so the button can say "Opening your wallet…" straight away. */
  onStatus?: (status: SignInStatus) => void;
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
  opts: Pick<SignInOptions, 'wallet' | 'pairing' | 'reusePairing' | 'discoverMs' | 'onStatus'> = {},
): Promise<{ wallet: WalletInterface; method: SignInMethod }> {
  const status = (s: SignInStatus) => {
    try {
      opts.onStatus?.(s);
    } catch {
      /* a UI callback must never break sign-in */
    }
  };
  if (opts.wallet) {
    status('opening');
    return { wallet: opts.wallet, method: 'wallet' };
  }
  status('finding');
  const found = await discoverBwalletX(opts.discoverMs ?? DEFAULT_DISCOVER_MS);
  if (found) {
    status('opening');
    return { wallet: found.wallet, method: found.method };
  }
  if (opts.reusePairing !== false) {
    const restored = await restorePairing(opts.pairing ?? {});
    if (restored) {
      status('opening');
      return { wallet: restored, method: 'pairing' };
    }
  }
  if (!opts.pairing) {
    throw Object.assign(new Error('bWalletX was not found in this browser'), { code: 'NOT_FOUND' });
  }
  status('pairing');
  return { wallet: await pairBwalletX(opts.pairing), method: 'pairing' };
}

/**
 * Sign the server's challenge with the user's bWalletX identity key. Post the result's
 * identityKey, nonce and signature to your verify route.
 */
export async function signInWithBwalletX(opts: SignInOptions): Promise<SignInResult> {
  const { wallet, method } = await connectBwalletX(opts);
  if (method !== 'pairing') await wallet.waitForAuthentication({}).catch(() => {});
  const { publicKey: identityKey } = await atStage('identity', () => wallet.getPublicKey({ identityKey: true }));
  try {
    opts.onStatus?.('signing');
  } catch {
    /* UI only */
  }
  const c = await atStage('challenge', () => opts.challenge(identityKey));
  const { signature } = await atStage('signature', () =>
    wallet.createSignature({
      protocolID: c.protocolID ?? LOGIN_PROTOCOL,
      keyID: c.keyID,
      counterparty: 'anyone',
      data: Array.from(new TextEncoder().encode(c.message)),
    }),
  );
  return { identityKey, signature: Array.from(signature), nonce: c.nonce, method, wallet };
}

/** Where a sign-in failed: the wallet's identity prompt, the site's challenge endpoint, or the wallet's signature. */
export type SignInStage = 'identity' | 'challenge' | 'signature' | 'verify';

/** Tags a failure with its stage (err.stage), keeping the original message, so a site can say what actually failed. */
export async function atStage<T>(stage: SignInStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (!(err as { stage?: string }).stage) Object.assign(err, { stage });
    throw err;
  }
}
