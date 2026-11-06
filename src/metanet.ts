/**
 * 0.7.0: "Use Metanet Desktop or another BRC-100 wallet" (owner, 6 Nov 2026: "ship a new one now with the metanet
 * option"). The same rules as the live bChatX door (bit-sign src/lib/metanet-door.ts):
 *
 *   1. bWalletX stays the default. It is found by its own announcement only, never by window.CWI, and the gold
 *      button's discovery NEVER picks Metanet (matchRemembered returns null for it).
 *   2. A visible, explicit choice. PINNED to WalletClient('json-api') on localhost:3321, never 'auto': 'auto' races
 *      the substrates starting with window.CWI, so the bWalletX extension would silently win and this would be a
 *      label, not a choice. On a first visit it connects ONLY on its own tap; nothing calls :3321 on page load.
 *   3. After a successful connect: the wallet TYPE for this origin (bwx:wallet = { type: 'metanet', substrate:
 *      'json-api' }) plus the identity keys known on this origin (bwx:known-keys). Public keys only; never a secret.
 *   4. Back with Metanet remembered: at most ONE silent attempt per page load, a 2 s window, and it goes on only if the
 *      identity key Metanet returns is already known here. Whatever answers on :3321 could be another profile, our own
 *      `bwalletx serve` agent wallet or any local process; letting an unknown key sign in silently would land the
 *      person in THAT key's account (login CSRF). Any failure is silent: no banner, no retry.
 *   5. "Not you? Use another wallet" and Disconnect forget the choice.
 *   6. Offered only on a computer and outside any frame (Metanet Desktop is a desktop app).
 *   7. The minimum asked: getVersion (is it running?), isAuthenticated (never prompts), the identity public key, then
 *      whatever the site's own call needs (the sign-in signature). No protocol permission requests at connect, and the
 *      calls go one at a time: two prompts at once is how Metanet Desktop froze on a "Trust" sheet (6 Nov 2026).
 */
import { WalletClient, type WalletInterface } from '@bsv/sdk';
import { rememberedIdentity } from './account.js';
import { isTouchDevice } from './device.js';
import { waitIfLocked } from './signin.js';
import type { ConnectedWallet, WalletOption } from './wallets.js';

/** The wallet type remembered for Metanet Desktop (and any BRC-100 wallet serving the JSON API on :3321). */
export const METANET_TYPE = 'metanet';
/** WalletOption.id of the Metanet option. */
export const METANET_OPTION_ID = METANET_TYPE;
/** Where Metanet Desktop serves the BRC-100 JSON API. */
export const METANET_JSON_API = 'http://localhost:3321';

export const METANET_LABEL = 'Use Metanet Desktop or another BRC-100 wallet';
export const METANET_NOTE = 'Metanet Desktop must be running on this computer';
/** Shown when Metanet is the wallet remembered on this site. */
export const METANET_REMEMBERED_NOTE = 'Signs in with Metanet Desktop on this computer.';
export const NOT_YOU_LABEL = 'Not you? Use another wallet';
export const METANET_UNREACHABLE = 'We couldn’t reach Metanet Desktop. Open it, then try again.';

/** How long Metanet Desktop has to answer getVersion after a tap. */
export const METANET_ANSWER_MS = 4_000;
/** The silent attempt's whole window (reachable, unlocked, identity key): short, since nobody asked for it. */
export const METANET_SILENT_MS = 2_000;

/** Nothing answered on localhost:3321 in time. `code` is NOT_FOUND, like every "no wallet here". */
export class MetanetUnreachableError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super(METANET_UNREACHABLE);
    this.name = 'MetanetUnreachableError';
  }
}

/** Inside any frame at all (bWalletX's or anyone's), or the top can't be read. */
/** The two window fields the frame check reads. */
export type FrameWindow = { readonly self: unknown; readonly top: unknown };

export function inAnyFrame(win: FrameWindow | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  if (!win) return false;
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/** Where the Metanet option is offered at all: a browser on a computer (not a phone or tablet), outside any frame. */
export function metanetOffered(
  env: { navigator?: Navigator; matchMedia?: (q: string) => MediaQueryList; window?: FrameWindow } = {},
): boolean {
  const win = env.window ?? (typeof window === 'undefined' ? undefined : window);
  if (!win) return false; // a server render: nothing to offer yet
  const nav = env.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const mm = env.matchMedia ?? (typeof matchMedia === 'undefined' ? undefined : (q: string) => matchMedia(q));
  return !isTouchDevice({ navigator: nav, matchMedia: mm }) && !inAnyFrame(win);
}

export interface MetanetOptions {
  /** This site's host, as WalletClient's originator (the browser sets the real Origin header). Default location.host. */
  originator?: string;
  /** How long Metanet has to answer getVersion. Default METANET_ANSWER_MS. */
  timeoutMs?: number;
  /** Tests and custom hosts: stands in for `new WalletClient('json-api', originator)`. */
  make?: () => WalletInterface;
}

function client(o: MetanetOptions): WalletInterface {
  if (o.make) return o.make();
  const originator = o.originator ?? (typeof location !== 'undefined' && location.host ? location.host : undefined);
  // Pinned: 'json-api' is HTTPWalletJSON on localhost:3321. It never falls back to an extension or window.CWI.
  return new WalletClient('json-api', originator);
}

async function answers(wallet: WalletInterface): Promise<boolean> {
  return Promise.resolve()
    .then(() => wallet.getVersion({}))
    .then((v) => typeof v?.version === 'string', () => false);
}

/**
 * The wallet on localhost:3321 once it has answered getVersion; MetanetUnreachableError if nothing does in time.
 * ⚠ WalletClient builds a pinned substrate in its constructor, so connectToSubstrate proves nothing: this asks.
 */
export async function connectMetanetDesktop(o: MetanetOptions = {}): Promise<WalletInterface> {
  let wallet: WalletInterface;
  try {
    wallet = client(o);
  } catch {
    throw new MetanetUnreachableError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ok = await Promise.race([answers(wallet), new Promise<false>((r) => (timer = setTimeout(() => r(false), o.timeoutMs ?? METANET_ANSWER_MS)))]);
  clearTimeout(timer);
  if (!ok) throw new MetanetUnreachableError();
  return wallet;
}

/**
 * "Use Metanet Desktop or another BRC-100 wallet" as a WalletOption. Nothing touches localhost until connect() runs,
 * i.e. after the tap. connect() always asks for the identity key first, on its own (also with `{ identity: false }`):
 * the sign-in then asks for the signature alone, so Metanet never gets two requests at once.
 */
export function metanetOption(o: MetanetOptions = {}): WalletOption {
  const opt: WalletOption = {
    id: METANET_OPTION_ID,
    name: METANET_LABEL,
    kind: 'brc100',
    isBwalletX: false,
    substrate: 'json-api',
    async connect(): Promise<ConnectedWallet> {
      const wallet = await connectMetanetDesktop(o);
      opt.wallet = wallet;
      await waitIfLocked(wallet);
      const { publicKey } = await wallet.getPublicKey({ identityKey: true });
      return { wallet, payer: wallet, identityKey: publicKey, optionId: opt.id, kind: 'brc100' };
    },
  };
  return opt;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Identity keys known on this origin (public keys, a hint for the silent attempt only).
 * ------------------------------------------------------------------------------------------------------------- */

/** localStorage key (per origin) for the identity keys that connected or signed in here. Public keys only. */
export const KNOWN_KEYS_KEY = 'bwx:known-keys';
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const MAX_KNOWN = 8;

/** The identity keys known on this origin, newest first. */
export function knownIdentityKeys(): string[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KNOWN_KEYS_KEY) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)) : [];
  } catch {
    return [];
  }
}

/** True when this identity key connected or signed in on this origin before (or is the last sign-in's key). */
export function isKnownIdentityKey(key: string | null | undefined): boolean {
  if (!key) return false;
  const k = key.toLowerCase();
  if (!KEY_RE.test(k)) return false;
  return knownIdentityKeys().includes(k) || rememberedIdentity()?.toLowerCase() === k;
}

/** Add an identity key to this origin's known keys (after a successful connect or sign-in). */
export function rememberKnownIdentityKey(key: string | null | undefined): void {
  const k = (key ?? '').toLowerCase();
  if (!KEY_RE.test(k)) return;
  try {
    const list = [k, ...knownIdentityKeys().filter((x) => x !== k)].slice(0, MAX_KNOWN);
    globalThis.localStorage?.setItem(KNOWN_KEYS_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: the next visit just needs a tap */
  }
}

/* ---------------------------------------------------------------------------------------------------------------
 * The silent attempt (rule 4).
 * ------------------------------------------------------------------------------------------------------------- */

let triedThisLoad = false;

/** True once this page load's one silent attempt has been used (however many buttons or providers mount). */
export function silentAttemptUsed(): boolean {
  return triedThisLoad;
}

/** Claim this page load's one silent attempt. False if it was already used. */
export function claimSilentAttempt(): boolean {
  if (triedThisLoad) return false;
  triedThisLoad = true;
  return true;
}

/** Tests only (and a single-page app that wants a fresh "page load"). */
export function resetSilentAttempt(): void {
  triedThisLoad = false;
}

/** Why a silent attempt stopped. Every one of them is silent: the normal choice stays on screen. */
export type SilentStop = 'used' | 'not-here' | 'unreachable' | 'locked' | 'slow' | 'unknown-key';

export type SilentMetanetResult = { ok: true; wallet: WalletInterface; identityKey: string } | { ok: false; stop: SilentStop };

/**
 * The silent part of a return visit: claim the page load's one attempt, then, within `windowMs` (2 s) in all,
 * Metanet must answer getVersion, say it is unlocked (isAuthenticated, which never prompts) and return an identity
 * key already known on this origin. Never waits for an unlock, never asks for anything else, never throws.
 */
export async function trySilentMetanet(o: MetanetOptions & { windowMs?: number } = {}): Promise<SilentMetanetResult> {
  if (!metanetOffered()) return { ok: false, stop: 'not-here' };
  if (!claimSilentAttempt()) return { ok: false, stop: 'used' };
  const run = async (): Promise<SilentMetanetResult> => {
    let wallet: WalletInterface;
    try {
      wallet = client(o);
    } catch {
      return { ok: false, stop: 'unreachable' };
    }
    if (!(await answers(wallet))) return { ok: false, stop: 'unreachable' };
    const unlocked = await Promise.resolve()
      .then(() => wallet.isAuthenticated({}))
      .then((r) => r?.authenticated === true, () => false);
    if (!unlocked) return { ok: false, stop: 'locked' };
    const identityKey = await Promise.resolve()
      .then(() => wallet.getPublicKey({ identityKey: true }))
      .then((r) => r.publicKey, () => null);
    if (!identityKey) return { ok: false, stop: 'unreachable' };
    if (!isKnownIdentityKey(identityKey)) return { ok: false, stop: 'unknown-key' };
    return { ok: true, wallet, identityKey };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([
    run().catch((): SilentMetanetResult => ({ ok: false, stop: 'unreachable' })),
    new Promise<SilentMetanetResult>((res) => (timer = setTimeout(() => res({ ok: false, stop: 'slow' }), o.windowMs ?? METANET_SILENT_MS))),
  ]);
  clearTimeout(timer);
  return r;
}

/* ---------------------------------------------------------------------------------------------------------------
 * logoutUrl is required with verifyUrl.
 * ------------------------------------------------------------------------------------------------------------- */

let warnedLogout = false;

const isProduction = (): boolean => {
  try {
    return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === 'production';
  } catch {
    return false;
  }
};

/**
 * (0.7.0) A sign-in with a verify route and no logout route: "Not you?" (and Disconnect) cannot end a session the
 * verify route already set, so the person stays signed in as the key they just rejected. Warns once per page, in
 * development only. Returns true when it warned.
 */
export function warnIfNoLogout(o: { verifyUrl?: string | null; logoutUrl?: string | null; where: string }): boolean {
  if (!o.verifyUrl || o.logoutUrl || warnedLogout || isProduction() || typeof console === 'undefined') return false;
  warnedLogout = true;
  console.warn(
    `@bwalletx/connect: ${o.where} has a verify URL but no logout URL. Set it: "Not you? Use another wallet" and ` +
      'Disconnect must be able to end a session the verify route created.',
  );
  return true;
}

/** Tests only. */
export function resetLogoutWarning(): void {
  warnedLogout = false;
}
