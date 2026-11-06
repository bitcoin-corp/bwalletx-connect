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
 *   5. (0.6.0) A returning visitor goes straight to the wallet they explicitly picked on this origin before. Only the
 *      wallet TYPE is remembered (localStorage, so per origin), never a key. Nothing that could prompt fires on load.
 *   6. (0.7.0) Metanet Desktop is never picked by the button's discovery, remembered or not: it is reached by its own
 *      tap ("Use Metanet Desktop or another BRC-100 wallet") or by the one silent, known-key-only attempt (metanet.ts).
 *
 * Pure functions: the provider, runConnect and <bwalletx-signin> all decide with decideWallet().
 */
import { RDNS_EXTENSION, RDNS_MOBILE } from './discover.js';
import { isUserRejection } from './account.js';
import { autoChoice, discoverWallets, isLocalDesktop, DESKTOP_OPTION_ID, type Substrate, type WalletOption } from './wallets.js';
import { METANET_TYPE, metanetOffered } from './metanet.js';

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
export type ChoiceReason = 'requested' | 'remembered' | 'bwalletx' | 'bwalletx-phone' | 'legacy' | 'chooser' | 'none';

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
  /** (0.6.0) The wallet the user picked on this origin before (rememberedWalletChoice()). Used when it is here. */
  remembered?: RememberedWallet | null;
  /** (0.6.0) "Switch" to bWalletX: ignore a remembered other wallet. */
  preferBwalletX?: boolean;
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
  if (o.remembered && !o.preferBwalletX) {
    const m = matchRemembered(list, o.remembered);
    if (m) return { option: m, reason: 'remembered' };
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

/* ---------------------------------------------------------------------------------------------------------------
 * 0.6.0: the remembered choice and auto-connect.
 * ------------------------------------------------------------------------------------------------------------- */

/** localStorage key (per origin, like all localStorage) for the wallet type picked here. Never holds a key. */
export const WALLET_CHOICE_KEY = 'bwx:wallet';

/** What is remembered: the wallet type and how it reached the page. Nothing that identifies the user. */
export interface RememberedWallet {
  type: string;
  substrate: Substrate;
}

const SUBSTRATES: readonly Substrate[] = ['extension', 'in-app', 'xdm', 'injected', 'window.CWI', 'json-api', 'cicada', 'pairing', 'adapter'];
const TYPE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const KEY_LIKE = /^(0[23][0-9a-f]{64}|04[0-9a-f]{128}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i;

/**
 * True when the same wallet can be found again next time: bWalletX, an announced wallet (by its rdns), a desktop
 * wallet, an app adapter. A bare window.CWI cannot (whoever holds it next time may be another wallet), so it is
 * never remembered.
 */
export function isRememberable(o: WalletOption): boolean {
  const t = walletTypeOf(o);
  return substrateOf(o) !== 'window.CWI' && TYPE_RE.test(t) && !KEY_LIKE.test(t);
}

/** Whether a successful connect counts as the user's explicit pick: bWalletX (they tapped its button), or chosen. */
export function isExplicitPick(o: WalletOption, reason: ChoiceReason): boolean {
  return o.isBwalletX || reason === 'chooser' || reason === 'requested' || reason === 'remembered';
}

/** Remember the wallet type picked on this origin (or forget with null). Silently skips what can't be remembered. */
export function rememberWalletChoice(o: WalletOption | null): void {
  try {
    if (!o) return void globalThis.localStorage?.removeItem(WALLET_CHOICE_KEY);
    if (!isRememberable(o)) return;
    const v: RememberedWallet & { v: 1 } = { type: walletTypeOf(o), substrate: substrateOf(o), v: 1 };
    globalThis.localStorage?.setItem(WALLET_CHOICE_KEY, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}

/** The wallet type picked on this origin before, or null. Anything malformed or key-like is ignored. */
export function rememberedWalletChoice(): RememberedWallet | null {
  try {
    const raw = globalThis.localStorage?.getItem(WALLET_CHOICE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<RememberedWallet>;
    if (typeof j.type !== 'string' || !TYPE_RE.test(j.type) || KEY_LIKE.test(j.type)) return null;
    if (!SUBSTRATES.includes(j.substrate as Substrate) || j.substrate === 'window.CWI') return null;
    return { type: j.type, substrate: j.substrate as Substrate };
  } catch {
    return null;
  }
}

/** Forget the remembered wallet (Disconnect does this). */
export function forgetWalletChoice(): void {
  rememberWalletChoice(null);
}

/** True when this wallet type is not bWalletX: show "Some features need bWalletX · Switch". */
export function needsBwalletX(type: string | null | undefined): boolean {
  return !!type && type !== BWALLETX_TYPE;
}

/**
 * (0.7.0) True when the signed-out button's tap goes to this remembered wallet instead of bWalletX ("Continue with your
 * wallet", the Switch note). Never for Metanet: the button never picks it (it has its own link and "Not you?").
 */
export function tapGoesElsewhere(type: string | null | undefined): boolean {
  return needsBwalletX(type) && type !== METANET_TYPE && type !== DESKTOP_OPTION_ID;
}

/** (0.7.0) A remembered desktop wallet on localhost (Metanet, 'desktop', json-api, cicada): never the button's pick. */
export function isLocalDesktopType(r: RememberedWallet): boolean {
  return r.type === METANET_TYPE || r.type === DESKTOP_OPTION_ID || r.substrate === 'json-api' || r.substrate === 'cicada';
}

/**
 * The option in `list` for a remembered wallet, or null when it isn't here. bWalletX counts only by its own marker
 * (or the phone, when the phone was picked). A remembered desktop wallet on localhost (Metanet / 'desktop') gives null
 * (0.7.0): the button never picks it; its own link does.
 */
export function matchRemembered(list: readonly WalletOption[], r: RememberedWallet): WalletOption | null {
  // 0.7.0: the button's discovery NEVER picks Metanet (owner rule 1), nor any desktop wallet on localhost ('desktop',
  // json-api, cicada: that is Metanet on :3321 too). Its own tap, or the silent attempt, reaches it.
  if (isLocalDesktopType(r)) return null;
  if (r.type === BWALLETX_TYPE) {
    return (r.substrate === 'pairing' ? list.find((o) => o.kind === 'pairing') : list.find(isPresentBwalletX)) ?? null;
  }
  return list.find((o) => !o.isBwalletX && !isLocalDesktop(o) && isRememberable(o) && walletTypeOf(o) === r.type) ?? null;
}

/**
 * What to do on page load for a returning visitor (0.6.0).
 *   'attach'       signed in already (a server session) and the remembered wallet is in the page: pick it up by
 *                  discovery alone (no wallet call, so no prompt) so pay/tip work without another tap;
 *   'wait-for-tap' anything else a wallet would have to answer (a key, a signature, a localhost probe, a relay
 *                  reconnect): nothing fires; the next tap goes straight to the remembered wallet;
 *   'silent-metanet' (0.7.0) Metanet Desktop remembered, on a computer outside any frame: ONE silent attempt this page
 *                  load (trySilentMetanet: 2 s, known identity keys only), else the normal choice;
 *   'none'         nothing remembered, or auto-connect off (or Metanet remembered where it isn't offered).
 */
export type AutoConnectAction = 'attach' | 'wait-for-tap' | 'silent-metanet' | 'none';

export interface AutoConnectPlan {
  action: AutoConnectAction;
  remembered: RememberedWallet | null;
  /** The remembered wallet isn't bWalletX: show "Some features need bWalletX · Switch". */
  needsBwalletX: boolean;
}

const ATTACHABLE: readonly Substrate[] = ['extension', 'in-app', 'xdm', 'injected'];

export function planAutoConnect(o: {
  remembered: RememberedWallet | null;
  signedIn: boolean;
  enabled?: boolean;
  /** (0.7.0) Metanet is offered here (a computer, outside any frame). Default metanetOffered(). */
  metanetHere?: boolean;
}): AutoConnectPlan {
  const r = o.remembered;
  if (!r || o.enabled === false) return { action: 'none', remembered: r, needsBwalletX: false };
  if (r.type === METANET_TYPE) {
    return { action: (o.metanetHere ?? metanetOffered()) ? 'silent-metanet' : 'none', remembered: r, needsBwalletX: false };
  }
  // A remembered 0.6.0 "Desktop wallet" is Metanet on :3321 too: never picked by the button, never tried silently.
  if (isLocalDesktopType(r)) return { action: 'none', remembered: r, needsBwalletX: false };
  const action: AutoConnectAction = o.signedIn && ATTACHABLE.includes(r.substrate) ? 'attach' : 'wait-for-tap';
  return { action, remembered: r, needsBwalletX: needsBwalletX(r.type) };
}

/**
 * Find the remembered wallet in the page by discovery alone: no wallet method is called, nothing touches localhost,
 * no relay is opened. null when it isn't here (or it isn't something that can be attached silently).
 */
export async function attachRemembered(r: RememberedWallet, o: { ms?: number } = {}): Promise<WalletOption | null> {
  if (!ATTACHABLE.includes(r.substrate)) return null;
  const list = await discoverWallets({ ms: o.ms });
  const m = matchRemembered(list, r);
  return m && m.kind === 'brc100' && m.wallet && ATTACHABLE.includes(substrateOf(m)) ? m : null;
}
