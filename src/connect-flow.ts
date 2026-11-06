/**
 * What BwalletXProvider.connect() does, without React: choose a wallet (bWalletX straight away when it is here; the
 * chooser otherwise, or when the user asked for "Other wallets"), open it, and sign in with ONE wallet sheet.
 */
import { rememberIdentity, rememberedIdentity } from './account.js';
import { signInAndVerify, type Challenge } from './signin.js';
import type { ConnectedWallet, Substrate, WalletOption } from './wallets.js';
import {
  isKnownIdentityKey, metanetOffered, metanetOption, rememberKnownIdentityKey, trySilentMetanet, METANET_OPTION_ID, type MetanetOptions,
} from './metanet.js';
import {
  attemptFor, decideWallet, isExplicitPick, outcomeOf, rememberWalletChoice, reportAttempt, substrateOf, walletTypeOf,
  type AttemptHook, type ChoiceReason, type RememberedWallet,
} from './choice.js';

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
  /**
   * (0.6.0) The wallet picked on this origin before (rememberedWalletChoice()). When it is here, the tap goes straight
   * to it, with no chooser, even when it isn't bWalletX (the user chose it).
   */
  remembered?: RememberedWallet | null;
  /** (0.6.0) After a successful connect the user explicitly picked, remember the wallet type for this origin. */
  remember?: boolean;
  /** (0.6.0) "Switch" to bWalletX: ignore a remembered other wallet (bWalletX here, else the chooser). */
  preferBwalletX?: boolean;
  /**
   * (0.7.0) The user tapped "Use Metanet Desktop or another BRC-100 wallet": connect to localhost:3321 (pinned
   * 'json-api', never 'auto'), with no chooser. Rejects NOT_SUPPORTED on a phone or inside a frame.
   */
  metanet?: boolean | MetanetOptions;
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
    if (o.metanet) {
      if (!metanetOffered()) throw Object.assign(new Error('Metanet Desktop runs on a computer, outside any frame.'), { code: 'NOT_SUPPORTED' });
      choice = metanetOption(typeof o.metanet === 'object' ? o.metanet : {});
      reason = 'requested';
      return await finish(o, choice, reason, started);
    }
    const d = decideWallet(list, {
      walletId: o.walletId,
      chooser: o.chooser,
      picker: o.picker,
      fastPath: o.fastPath,
      remembered: o.remembered,
      preferBwalletX: o.preferBwalletX,
    });
    choice = d.option;
    reason = d.reason;
    if (!choice && d.reason === 'chooser') choice = await o.pick(list);
    if (!choice) {
      if (d.reason === 'none' || !list.length) throw Object.assign(new Error('No wallet found. Get bWalletX at bwalletx.com.'), { code: 'NOT_FOUND' });
      reportAttempt(o.onAttempt, attemptFor(null, 'cancelled', started));
      return null;
    }
    return await finish(o, choice, reason, started);
  } catch (e) {
    reportAttempt(o.onAttempt, attemptFor(choice, outcomeOf(e), started));
    throw e;
  }
}

/** Open the chosen wallet and sign in (one wallet sheet), remember the pick, report the attempt. */
async function finish(o: ConnectFlowOptions, choice: WalletOption, reason: ChoiceReason, started: number): Promise<ConnectFlowResult> {
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
      // Metanet's connect() just checked the lock: don't ask again (rule 7, the minimum).
      skipWaitForAuthentication: choice.id === METANET_OPTION_ID,
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
  if (o.remember && isExplicitPick(choice, reason)) rememberWalletChoice(choice);
  // 0.7.0: the identity keys known on this origin (public keys), for Metanet's known-key-only silent attempt.
  if (o.remember) rememberKnownIdentityKey(identityKey);
  reportAttempt(o.onAttempt, attemptFor(choice, signedIn ? 'signed-in' : 'connected', started));
  return { connected: cw, identityKey, handle, paymail, signedIn, walletType: walletTypeOf(choice), substrate: substrateOf(choice), reason };
}

export interface SilentMetanetOptions extends MetanetOptions {
  /** With verifyUrl: sign in once the known key is confirmed (the signature alone; the key is already in hand). */
  challengeUrl?: string;
  verifyUrl?: string;
  post?: (url: string, body: unknown) => Promise<Record<string, unknown>>;
  /** A server session is already in place for this identity key: attach the wallet only if it is the same key. */
  sessionKey?: string | null;
  /** The silent window, ms. Default METANET_SILENT_MS (2 s). */
  windowMs?: number;
  /** Called when the known key is confirmed and the sign-in signature is about to be asked for. */
  onSignIn?: () => void;
  /** "Not you?" was pressed meanwhile: land nobody (and end a session the verify route already set, via `logout`). */
  isAbandoned?: () => boolean;
  logout?: () => Promise<unknown>;
  onAttempt?: AttemptHook;
}

/**
 * (0.7.0) The return visit with Metanet remembered: ONE silent attempt per page load (trySilentMetanet: 2 s, known
 * identity keys only), then, with a session already there, attach the wallet when it is the session's key; without
 * one, sign in with the signature alone. Resolves null on any stop or failure, and never throws: the caller shows
 * the normal choice and waits for a tap, with no error.
 */
export async function runSilentMetanet(o: SilentMetanetOptions = {}): Promise<ConnectFlowResult | null> {
  const s = await trySilentMetanet(o);
  if (!s.ok || o.isAbandoned?.()) return null;
  const started = Date.now();
  const opt = metanetOption(o);
  opt.wallet = s.wallet;
  const cw: ConnectedWallet = { wallet: s.wallet, payer: s.wallet, identityKey: s.identityKey, optionId: METANET_OPTION_ID, kind: 'brc100' };
  const done = (signedIn: boolean, handle: string | null = null, paymail: string | null = null): ConnectFlowResult => {
    rememberWalletChoice(opt);
    rememberKnownIdentityKey(s.identityKey);
    reportAttempt(o.onAttempt, attemptFor(opt, signedIn ? 'signed-in' : 'connected', started));
    return { connected: cw, identityKey: s.identityKey, handle, paymail, signedIn, walletType: walletTypeOf(opt), substrate: 'json-api', reason: 'remembered' };
  };
  if (o.sessionKey !== undefined && o.sessionKey !== null) {
    return o.sessionKey.toLowerCase() === s.identityKey.toLowerCase() ? done(true) : null;
  }
  if (!o.challengeUrl || !o.verifyUrl || !o.post) return done(false);
  if (!isKnownIdentityKey(s.identityKey)) return null;
  try {
    o.onSignIn?.();
    const post = o.post;
    const { result, verified } = await signInAndVerify({
      wallet: s.wallet,
      identityKey: s.identityKey,
      skipWaitForAuthentication: true, // trySilentMetanet just saw it unlocked
      challenge: (key) => post(o.challengeUrl!, key ? { identityKey: key } : {}) as unknown as Promise<Challenge>,
      verify: (r) => post(o.verifyUrl!, { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature }),
    });
    if (o.isAbandoned?.()) {
      await Promise.resolve(o.logout?.()).catch(() => undefined);
      return null;
    }
    rememberIdentity(result.identityKey);
    return done(true, (verified.handle as string | undefined) ?? null, (verified.paymail as string | undefined) ?? null);
  } catch (e) {
    reportAttempt(o.onAttempt, attemptFor(opt, outcomeOf(e), started));
    return null;
  }
}
