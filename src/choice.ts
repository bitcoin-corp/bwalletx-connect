/**
 * Which wallet a sign-in uses (RB, 5 Nov 2026: bWalletX is the default on our sites; no other wallet may take the
 * sign-in flow).
 *
 *   1. bWalletX is recognised by its OWN marker only: its BRC-100 announcement (rdns com.bwalletx.extension or
 *      space.bwallet.mobile) or the bWalletX app frame (XDM, allowlisted origins). Never by who holds window.CWI.
 *   2. bWalletX here → straight to its sheet. No site chooser; "Other wallets" is a small link beside the button.
 *   3. No bWalletX → the chooser, "Get bWalletX" first, then whatever was detected. Another wallet is never connected
 *      without the user picking it.
 *   4. Nothing probes localhost until the user taps "Desktop wallet" (desktopOption).
 *
 * Pure functions: the provider, runConnect and <bwalletx-signin> all decide with decideWallet().
 */
import { RDNS_EXTENSION, RDNS_MOBILE } from './discover.js';
import { isUserRejection } from './account.js';
import { autoChoice, DESKTOP_OPTION_ID, type Substrate, type WalletOption } from './wallets.js';

/** The wallet type every bWalletX (extension, in-app, app frame, phone) reports. */
export const BWALLETX_TYPE = 'bwalletx';

/** How the option reaches the page (WalletOption.substrate, inferred for options built elsewhere). */
export function substrateOf(o: WalletOption): Substrate {
  if (o.substrate) return o.substrate;
  if (o.kind === 'pairing') return 'pairing';
  // An option the app built itself and marked as bWalletX (e.g. from findBwalletX()): its own assertion, not a guess
  // from window.CWI (discoverWallets never marks window.CWI as bWalletX).
  if (o.isBwalletX && o.kind === 'brc100') return o.rdns === RDNS_MOBILE ? 'in-app' : o.id === 'bwalletx-xdm' ? 'xdm' : 'extension';
  if (o.kind === 'handcash' || o.kind === 'custom') return 'adapter';
  if (o.rdns === RDNS_EXTENSION) return 'extension';
  if (o.rdns === RDNS_MOBILE) return 'in-app';
  if (o.id === 'window.CWI') return 'window.CWI';
  if (o.id === 'localhost:3321' || o.id === DESKTOP_OPTION_ID) return 'json-api';
  if (o.id === 'localhost:3301') return 'cicada';
  return 'injected';
}

/** 'bwalletx' for any bWalletX; otherwise the wallet's rdns, else its option id ('desktop', 'window.CWI', 'handcash'). */
export function walletTypeOf(o: WalletOption): string {
  return o.isBwalletX ? BWALLETX_TYPE : (o.rdns ?? o.id);
}

const OWN_MARKERS: readonly Substrate[] = ['extension', 'in-app', 'xdm'];

/**
 * bWalletX found in this browser by its own marker (announcement or app frame). A wallet that only sits on
 * window.CWI never counts, whatever it claims to be.
 */
export function isPresentBwalletX(o: WalletOption): boolean {
  return o.isBwalletX && o.kind === 'brc100' && !!o.wallet && OWN_MARKERS.includes(substrateOf(o));
}

/** True when bWalletX itself is in this browser (not just phone pairing). */
export function hasBwalletX(list: readonly WalletOption[]): boolean {
  return list.some(isPresentBwalletX);
}

/** Wallets other than bWalletX that are actually in this browser (announced, window.CWI, or a probed desktop wallet). */
export function otherDetected(list: readonly WalletOption[]): WalletOption[] {
  return list.filter((o) => !o.isBwalletX && o.kind === 'brc100' && !!o.wallet);
}

/** The chooser's order: bWalletX here, phone pairing, other detected wallets, app-supplied options last. */
export function chooserOrder(list: readonly WalletOption[]): WalletOption[] {
  const rank = (o: WalletOption) => (isPresentBwalletX(o) ? 0 : o.isBwalletX ? 1 : o.kind === 'brc100' ? 2 : o.kind === 'custom' ? 3 : 4);
  return list.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o);
}

/**
 * Why decideWallet chose what it did. 'requested': walletId; 'bwalletx': bWalletX is here (fast path);
 * 'bwalletx-phone': picker off and no bWalletX here, so the phone; 'legacy': fastPath false (0.5.5 autoChoice);
 * 'chooser': show the chooser; 'none': nothing to offer.
 */
export type ChoiceReason = 'requested' | 'bwalletx' | 'bwalletx-phone' | 'legacy' | 'chooser' | 'none';

export interface WalletChoice {
  option: WalletOption | null;
  reason: ChoiceReason;
}

export interface DecideWalletOptions {
  /** Use this option (an explicit choice the site already has). */
  walletId?: string;
  /** "Other wallets": the user asked for the chooser, so show it even with bWalletX here. */
  chooser?: boolean;
  /** false: never show the chooser (bWalletX, else the phone, else nothing; never another wallet). */
  picker?: boolean;
  /** The bWalletX-first rule. Default true; false restores the 0.5.5 behaviour (autoChoice). */
  fastPath?: boolean;
}

/** The wallet to connect now, or the chooser ({ option: null, reason: 'chooser' }). */
export function decideWallet(list: readonly WalletOption[], o: DecideWalletOptions = {}): WalletChoice {
  if (o.walletId) {
    const w = list.find((x) => x.id === o.walletId);
    if (w) return { option: w, reason: 'requested' };
  }
  if (o.chooser) return { option: null, reason: list.length || o.picker !== false ? 'chooser' : 'none' };
  if (o.fastPath === false) {
    const a = autoChoice([...list], o.picker === false);
    return a === undefined ? { option: null, reason: 'chooser' } : a === null ? { option: null, reason: 'none' } : { option: a, reason: 'legacy' };
  }
  const b = list.find(isPresentBwalletX);
  if (b) return { option: b, reason: 'bwalletx' };
  if (o.picker === false) {
    const phone = list.find((x) => x.isBwalletX);
    return phone ? { option: phone, reason: 'bwalletx-phone' } : { option: null, reason: 'none' };
  }
  return list.length ? { option: null, reason: 'chooser' } : { option: null, reason: 'none' };
}

/** How a connect attempt ended. */
export type AttemptOutcome = 'signed-in' | 'connected' | 'cancelled' | 'rejected' | 'not-found' | 'error';

/**
 * One connect attempt, for your metrics. Deliberately nothing else: no identity key, address, paymail, handle,
 * origin or error text. `walletType`/`substrate` are null when no wallet was chosen (chooser closed, nothing found).
 */
export interface ConnectAttempt {
  walletType: string | null;
  substrate: Substrate | null;
  outcome: AttemptOutcome;
  /** From the tap to the outcome, rounded to whole ms. */
  ms: number;
}

export type AttemptHook = (attempt: ConnectAttempt) => void;

/** The outcome for an error thrown by a connect attempt. */
export function outcomeOf(e: unknown): AttemptOutcome {
  const err = e as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (err?.code === 'NOT_FOUND') return 'not-found';
  if (err?.name === 'AbortError' || err?.message === 'cancelled') return 'cancelled';
  if (isUserRejection(e)) return 'rejected';
  return 'error';
}

/** Build the attempt record for `option` (or none). */
export function attemptFor(option: WalletOption | null | undefined, outcome: AttemptOutcome, startedAt: number, now = Date.now()): ConnectAttempt {
  return {
    walletType: option ? walletTypeOf(option) : null,
    substrate: option ? substrateOf(option) : null,
    outcome,
    ms: Math.max(0, Math.round(now - startedAt)),
  };
}

/** Call the hook with exactly the four fields; a throwing hook never breaks sign-in. */
export function reportAttempt(hook: AttemptHook | undefined, a: ConnectAttempt): void {
  if (!hook) return;
  try {
    hook(Object.freeze({ walletType: a.walletType, substrate: a.substrate, outcome: a.outcome, ms: a.ms }));
  } catch {
    /* metrics must never break sign-in */
  }
}
