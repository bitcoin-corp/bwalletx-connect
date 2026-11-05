/**
 * What BwalletXProvider.connect() does, without React: choose a wallet (bWalletX straight away when it is here; the
 * chooser otherwise, or when the user asked for "Other wallets"), open it, and sign in with ONE wallet sheet.
 */
import { rememberIdentity, rememberedIdentity } from './account.js';
import { signInAndVerify, type Challenge } from './signin.js';
import type { ConnectedWallet, Substrate, WalletOption } from './wallets.js';
import { attemptFor, decideWallet, outcomeOf, reportAttempt, substrateOf, walletTypeOf, type AttemptHook, type ChoiceReason } from './choice.js';

export interface ConnectFlowOptions {
  /** The wallets found (discoverWallets). */
  list: WalletOption[];
  /** Connect this option without asking. */
  walletId?: string;
  /** false: never show the chooser (bWalletX, else the phone; never another wallet unasked). Default true. */
  picker?: boolean;
  /** "Other wallets": show the chooser even when bWalletX is here. */
  chooser?: boolean;
  /**
   * bWalletX first (0.5.6, default true): bWalletX in this browser is connected with no chooser; without it the
   * chooser opens ("Get bWalletX" first) and no other wallet is connected unless picked. false: the 0.5.5 rule.
   */
  fastPath?: boolean;
  /** Show the chooser; resolves null when closed. chooseWallet (modal.ts) or your own UI. */
  pick: (list: WalletOption[]) => Promise<WalletOption | null>;
  /** With verifyUrl: sign in after connecting. */
  challengeUrl?: string;
  verifyUrl?: string;
  challengeNeedsIdentityKey?: boolean;
  /** POST JSON; throws with `status` on a non-2xx answer. */
  post: (url: string, body: unknown) => Promise<Record<string, unknown>>;
  /** Called once per attempt with { walletType, substrate, outcome, ms }. No keys, addresses or identity data. */
  onAttempt?: AttemptHook;
}

export interface ConnectFlowResult {
  connected: ConnectedWallet;
  identityKey: string | null;
  handle: string | null;
  paymail: string | null;
  signedIn: boolean;
  /** 'bwalletx' for bWalletX, else the wallet's rdns / option id. */
  walletType: string;
  substrate: Substrate;
  /** Why this wallet: 'bwalletx' (fast path), 'chooser' (picked), 'requested' (walletId), … */
  reason: ChoiceReason;
}

/** Resolves null when the user closed the chooser. Throws NOT_FOUND when there is nothing to connect. */
export async function runConnect(o: ConnectFlowOptions): Promise<ConnectFlowResult | null> {
  const started = Date.now();
  const { list } = o;
  let choice: WalletOption | null = null;
  let reason: ChoiceReason = 'none';
  try {
    const d = decideWallet(list, { walletId: o.walletId, chooser: o.chooser, picker: o.picker, fastPath: o.fastPath });
    choice = d.option;
    reason = d.reason;
    if (!choice && d.reason === 'chooser') choice = await o.pick(list);
    if (!choice) {
      if (d.reason === 'none' || !list.length) throw Object.assign(new Error('No wallet found. Get bWalletX at bwalletx.com.'), { code: 'NOT_FOUND' });
      reportAttempt(o.onAttempt, attemptFor(null, 'cancelled', started));
      return null;
    }
    const signIn = !!(o.challengeUrl && o.verifyUrl) && choice.kind !== 'handcash';
    // Signing in: open the wallet WITHOUT asking for the key; the key comes with the signature, in one sheet.
    const cw = await choice.connect(signIn ? { identity: false } : undefined);
    let handle = cw.handle ?? null;
    let paymail = cw.paymail ?? null;
    let identityKey = cw.identityKey;
    let signedIn = false;
    if (cw.wallet && signIn) {
      const { result, verified } = await signInAndVerify({
        wallet: cw.wallet,
        identityKey: cw.identityKey ?? undefined,
        // The key that signed in here last time: a repeat sign-in is then the signature alone.
        identityKeyHint: rememberedIdentity(),
        challengeNeedsIdentityKey: o.challengeNeedsIdentityKey,
        challenge: (key) => o.post(o.challengeUrl!, key ? { identityKey: key } : {}) as unknown as Promise<Challenge>,
        verify: (r) => o.post(o.verifyUrl!, { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature }),
      });
      rememberIdentity(result.identityKey);
      identityKey = result.identityKey;
      handle = (verified.handle as string | undefined) ?? handle;
      paymail = (verified.paymail as string | undefined) ?? paymail;
      signedIn = true;
    } else if (cw.wallet && !identityKey) {
      identityKey = (await cw.wallet.getPublicKey({ identityKey: true })).publicKey;
    }
    reportAttempt(o.onAttempt, attemptFor(choice, signedIn ? 'signed-in' : 'connected', started));
    return { connected: cw, identityKey, handle, paymail, signedIn, walletType: walletTypeOf(choice), substrate: substrateOf(choice), reason };
  } catch (e) {
    reportAttempt(o.onAttempt, attemptFor(choice, outcomeOf(e), started));
    throw e;
  }
}
