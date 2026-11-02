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
 * 'signing': the challenge arrived, the wallet's sign-in approval is being asked for.
 */
export type SignInStatus = 'finding' | 'opening' | 'pairing' | 'signing';

export interface SignInOptions {
  /**
   * Ask your server for a challenge. Since 0.5.5 it is called BEFORE the wallet is asked anything, and gets an identity
   * key only when you pass `identityKey` (an identity you already connected) or set `challengeNeedsIdentityKey`;
   * otherwise undefined. The 0.5.5 server helpers (createChallenge) accept no key, and verifySignIn binds the key the
   * browser then claims to the signature. A pre-0.5.5 server that refuses a keyless challenge is detected and retried
   * in the old order automatically.
   */
  challenge(identityKey?: string): Promise<Challenge>;
  /**
   * The identity key you already have from an earlier connect (reuse the connected identity): the wallet is then asked
   * for the signature only. Without it, getPublicKey({ identityKey: true }) and createSignature go to the wallet
   * together (Promise.all), so the wallet shows ONE sheet, not three.
   */
  identityKey?: string;
  /**
   * Servers older than 0.5.5 refuse a challenge without an identity key. Set true to use the old order straight away
   * (identity key, then the challenge, then the signature: two wallet calls). Without it, the old order is used only
   * after such a server has refused a keyless challenge.
   */
  challengeNeedsIdentityKey?: boolean;
  /** Skip waitForAuthentication before signing (the provider already waited). Default false. */
  skipWaitForAuthentication?: boolean;
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
 * Wait for the user to unlock only when the wallet says it is locked. isAuthenticated never shows anything; an
 * unconditional waitForAuthentication is not free: bWalletX answers it by fetching the site's manifest.json and, when
 * that asks for permissions, shows a separate sheet, once per call.
 */
export async function waitIfLocked(wallet: WalletInterface): Promise<void> {
  let ok = false;
  try {
    ok = !!(await wallet.isAuthenticated({}))?.authenticated;
  } catch {
    /* not supported or failed: wait below */
  }
  if (!ok) await Promise.resolve().then(() => wallet.waitForAuthentication({})).catch(() => {});
}

/**
 * True when a server refused a challenge because it wanted an identity key (createChallenge before 0.5.5 answers 400
 * "identityKey must be a compressed public key (66 hex chars)").
 */
export function challengeWantsIdentityKey(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /identityKey/i.test(msg);
}

/**
 * Sign the server's challenge with the user's bWalletX identity key. Post the result's identityKey, nonce and
 * signature to your verify route.
 *
 * Wallet calls, in order:
 *   1. the challenge comes from your server first (no wallet call);
 *   2. getPublicKey({ identityKey: true }) and createSignature go to the wallet TOGETHER, so the wallet merges them
 *      into one approval. With `identityKey` (already connected) only createSignature is asked for.
 */
export async function signInWithBwalletX(opts: SignInOptions): Promise<SignInResult> {
  const { wallet, method } = await connectBwalletX(opts);
  if (method !== 'pairing' && !opts.skipWaitForAuthentication) await waitIfLocked(wallet);
  const status = () => {
    try {
      opts.onStatus?.('signing');
    } catch {
      /* UI only */
    }
  };
  const sign = (c: Challenge) =>
    wallet.createSignature({
      protocolID: c.protocolID ?? LOGIN_PROTOCOL,
      keyID: c.keyID,
      counterparty: 'anyone',
      data: Array.from(new TextEncoder().encode(c.message)),
    });

  const keyFirst = async (): Promise<SignInResult> => {
    // Servers before 0.5.5: key first, then the challenge for it, then the signature.
    const { publicKey: identityKey } = await atStage('identity', () => wallet.getPublicKey({ identityKey: true }));
    status();
    const c = await atStage('challenge', () => opts.challenge(identityKey));
    const { signature } = await atStage('signature', () => sign(c));
    return { identityKey, signature: Array.from(signature), nonce: c.nonce, method, wallet };
  };

  if (opts.challengeNeedsIdentityKey && !opts.identityKey) return keyFirst();

  // One sheet: the challenge comes first (no wallet call), then the key and the signature are asked for together.
  let c: Challenge;
  try {
    c = await atStage('challenge', () => opts.challenge(opts.identityKey));
  } catch (e) {
    if (!opts.identityKey && challengeWantsIdentityKey(e)) return keyFirst();
    throw e;
  }
  status();
  const [{ publicKey: identityKey }, { signature }] = await Promise.all([
    opts.identityKey
      ? Promise.resolve({ publicKey: opts.identityKey })
      : atStage('identity', () => wallet.getPublicKey({ identityKey: true })),
    atStage('signature', () => sign(c)),
  ]);
  return { identityKey, signature: Array.from(signature), nonce: c.nonce, method, wallet };
}

export interface SignInAndVerifyOptions extends SignInOptions {
  /** POST the result to your verify route; resolve with its JSON. A 401 (status on the error) means "sign-in failed". */
  verify: (r: SignInResult) => Promise<Record<string, unknown>>;
  /**
   * A remembered identity key (rememberedIdentity()). Used like `identityKey` (one wallet call: the signature only),
   * but if the server rejects the signature (another account is active now), it is dropped and the sign-in is retried
   * with the key asked for.
   */
  identityKeyHint?: string;
}

/** signInWithBwalletX + your verify route, with the identity-hint fallback. */
export async function signInAndVerify(opts: SignInAndVerifyOptions): Promise<{ result: SignInResult; verified: Record<string, unknown> }> {
  const hinted = !opts.identityKey && !!opts.identityKeyHint;
  const r = await signInWithBwalletX({ ...opts, identityKey: opts.identityKey ?? opts.identityKeyHint });
  try {
    return { result: r, verified: await atStage('verify', () => opts.verify(r)) };
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (!hinted || status !== 401) throw e;
    const again = await signInWithBwalletX({ ...opts, wallet: r.wallet, identityKey: undefined, skipWaitForAuthentication: true });
    return { result: again, verified: await atStage('verify', () => opts.verify(again)) };
  }
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
