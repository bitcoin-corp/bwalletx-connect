/**
 * Every wallet the user could connect with, behind one interface. BRC-100 first: bWalletX, then any
 * other wallet that announces itself (Yours, Metanet, ...), the in-app browser, optional localhost
 * desktop wallets, phone pairing, and app-supplied adapters (e.g. the transitional HandCash one).
 */
import { WalletClient, type WalletInterface } from '@bsv/sdk';
import { BWALLETX_RDNS, RDNS_EXTENSION, RDNS_MOBILE, isFramed, probeXdm } from './discover.js';
import { pairBwalletX, restorePairing, type PairingOptions } from './pair.js';
import type { PaySource } from './pay.js';
import { waitIfLocked } from './signin.js';

export type WalletKind = 'brc100' | 'pairing' | 'handcash' | 'custom';

/**
 * How a wallet reaches the page. 'extension' / 'in-app': bWalletX announced itself (its own rdns); 'xdm': the bWalletX
 * app frame around the page; 'injected': another wallet that announced itself; 'window.CWI': something set window.CWI
 * without announcing (it can't be told apart from any other wallet); 'json-api' / 'cicada': a desktop wallet on
 * localhost (Metanet / BSV Desktop on 3321, Cicada on 3301); 'pairing': bWalletX on a phone over the relay;
 * 'adapter': an app-supplied option (HandCash today).
 */
export type Substrate = 'extension' | 'in-app' | 'xdm' | 'injected' | 'window.CWI' | 'json-api' | 'cicada' | 'pairing' | 'adapter';

export interface ConnectedWallet {
  /** The BRC-100 wallet. null for a non-BRC-100 adapter (HandCash today). */
  wallet: WalletInterface | null;
  /** What pay/tip use: the BRC-100 wallet, or the adapter's own payer. */
  payer: PaySource | null;
  /** The identity public key (hex) when the wallet has one. */
  identityKey: string | null;
  handle?: string;
  paymail?: string;
  /** Which option connected. */
  optionId: string;
  kind: WalletKind;
  /** True for adapters kept only until the vendor ships BRC-100. */
  transitional?: boolean;
}

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  kind: WalletKind;
  rdns?: string;
  /** True for bWalletX (extension, in-app or paired). */
  isBwalletX: boolean;
  /** How it reaches the page (0.5.6). Options built by this package always set it. */
  substrate?: Substrate;
  /** The BRC-100 wallet behind a detected option (brc100 kind), when known before connecting. */
  wallet?: WalletInterface;
  /**
   * Open the wallet. By default it also asks for the identity key (one wallet call). Pass `{ identity: false }` when
   * you sign in straight after (BwalletXProvider does): the key then comes with the sign-in signature, in ONE sheet,
   * and `identityKey` is null here.
   */
  connect(opts?: ConnectOptions): Promise<ConnectedWallet>;
}

export interface ConnectOptions {
  /** Ask for the identity key now. Default true. */
  identity?: boolean;
}

async function brc100Connected(wallet: WalletInterface, o: Pick<WalletOption, 'id' | 'kind'>, c: ConnectOptions = {}): Promise<ConnectedWallet> {
  if (c.identity === false) return { wallet, payer: wallet, identityKey: null, optionId: o.id, kind: o.kind };
  await waitIfLocked(wallet);
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  return { wallet, payer: wallet, identityKey: publicKey, optionId: o.id, kind: o.kind };
}

/** Wrap any BRC-100 wallet as a picker option. */
export function brc100Option(
  wallet: WalletInterface,
  info: { id: string; name: string; icon?: string; rdns?: string; isBwalletX?: boolean; substrate?: Substrate },
): WalletOption {
  const opt: WalletOption = {
    id: info.id,
    name: info.name,
    icon: info.icon,
    rdns: info.rdns,
    kind: 'brc100',
    isBwalletX: info.isBwalletX ?? false,
    substrate: info.substrate,
    wallet,
    connect: (c) => brc100Connected(wallet, opt, c),
  };
  return opt;
}

/** Phone / web.bwalletx.com pairing as an option (shows a QR through `pairing`). Reuses a stored pairing first. */
export function pairingOption(pairing: PairingOptions | (() => PairingOptions)): WalletOption {
  const opt: WalletOption = {
    id: 'bwalletx-pairing',
    name: 'bWalletX on your phone',
    kind: 'pairing',
    isBwalletX: true,
    substrate: 'pairing',
    async connect(c) {
      const p = typeof pairing === 'function' ? pairing() : pairing;
      const w = (await restorePairing(p)) ?? (await pairBwalletX(p));
      return brc100Connected(w, opt, c);
    },
  };
  return opt;
}

export interface HandCashAdapterOptions {
  /**
   * Your existing HandCash Connect login (redirect/popup + your server route). Resolve with the
   * profile once the user is signed in. This package does not import any HandCash SDK.
   */
  login(): Promise<{ handle: string; paymail?: string; identityKey?: string }>;
  /** Your existing HandCash pay call (usually a server route using the auth token). Optional. */
  pay?: Extract<PaySource, { pay: unknown }>['pay'];
  icon?: string;
}

/**
 * TRANSITIONAL. Keeps existing HandCash users working behind the same picker until HandCash's
 * BRC-100 support ships; then remove this and HandCash appears as an ordinary BRC-100 wallet.
 */
export function handcashAdapter(o: HandCashAdapterOptions): WalletOption {
  const opt: WalletOption = {
    id: 'handcash',
    name: 'HandCash',
    icon: o.icon,
    kind: 'handcash',
    isBwalletX: false,
    substrate: 'adapter',
    async connect() {
      const p = await o.login();
      return {
        wallet: null,
        payer: o.pay ? { pay: o.pay } : null,
        identityKey: p.identityKey ?? null,
        handle: p.handle,
        paymail: p.paymail ?? `${p.handle.replace(/^\$/, '')}@handcash.io`,
        optionId: opt.id,
        kind: 'handcash',
        transitional: true,
      };
    },
  };
  return opt;
}

export interface DiscoverWalletsOptions {
  /** Longest wait for BRC-100 announcements, ms. Default 300; ends early once a wallet has announced. */
  ms?: number;
  /**
   * Also probe desktop wallets on localhost (Metanet / json-api on 3321, Cicada on 3301) while listing.
   * Off by default, and best left off: Chrome asks for Local Network Access on the first probe. The chooser
   * (chooseWallet) offers "Desktop wallet" instead, which probes only when the user taps it (desktopOption).
   */
  probeLocal?: boolean;
  /** Add the phone pairing option (needs a way to show the QR, e.g. pairingModal()). */
  pairing?: PairingOptions | (() => PairingOptions);
  /** App-supplied options appended at the end (e.g. handcashAdapter(...)). */
  extra?: WalletOption[];
}

const NAMES: Record<string, string> = { [RDNS_EXTENSION]: 'bWalletX', 'space.bwallet.mobile': 'bWalletX' };

async function probe(substrate: 'json-api' | 'Cicada', ms: number): Promise<WalletInterface | null> {
  try {
    const w = new WalletClient(substrate);
    const ok = await Promise.race([w.isAuthenticated({}).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    return ok ? w : null;
  } catch {
    return null;
  }
}

/**
 * True when window.CWI is a wallet that already announced itself, so the picker must not list it twice. bWalletX
 * (extension and in-app) sets window.CWI to the very object it announces; the in-app browser is matched by rdns too.
 */
export function cwiIsAnnounced(cwi: WalletInterface, announced: WalletOption[]): boolean {
  return announced.some((o) => o.wallet === cwi || o.rdns === RDNS_MOBILE);
}

/** All wallets we can see, bWalletX first. SSR-safe: resolves [] (plus `extra`) outside a browser. */
export async function discoverWallets(o: DiscoverWalletsOptions = {}): Promise<WalletOption[]> {
  const out: WalletOption[] = [];
  const ms = o.ms ?? 300;
  if (typeof window !== 'undefined') {
    const seen = new Map<string, WalletOption>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as { info?: { rdns?: string; name?: string; icon?: string; uuid?: string }; wallet?: WalletInterface } | undefined;
      if (!d?.wallet) return;
      const rdns = d.info?.rdns ?? d.info?.uuid ?? `wallet-${seen.size}`;
      if (seen.has(rdns)) return;
      const isB = (BWALLETX_RDNS as readonly string[]).includes(rdns);
      const substrate: Substrate = rdns === RDNS_EXTENSION ? 'extension' : rdns === RDNS_MOBILE ? 'in-app' : 'injected';
      seen.set(rdns, brc100Option(d.wallet, { id: rdns, rdns, name: NAMES[rdns] ?? d.info?.name ?? rdns, icon: d.info?.icon, isBwalletX: isB, substrate }));
    };
    window.addEventListener('brc100:announceWallet', onAnnounce);
    window.dispatchEvent(new Event('brc100:requestWallet'));
    const local = o.probeLocal ? Promise.all([probe('json-api', ms), probe('Cicada', ms)]) : Promise.resolve([null, null]);
    // Wallets answer requestWallet synchronously; once one has, a short grace catches any slower sibling.
    await new Promise((r) => setTimeout(r, seen.size > 0 || (window as unknown as { CWI?: unknown }).CWI ? Math.min(ms, 50) : ms));
    window.removeEventListener('brc100:announceWallet', onAnnounce);
    out.push(...seen.values());
    // Inside the bWalletX app frame nothing is injected: bWalletX answers over XDM, only from its own origins.
    if (![...seen.values()].some((w) => w.isBwalletX) && isFramed()) {
      const x = await probeXdm(Math.max(ms, 1200));
      if (x) out.push(brc100Option(x, { id: 'bwalletx-xdm', name: 'bWalletX', isBwalletX: true, substrate: 'xdm' }));
    }
    // A window.CWI nobody announced is listed under a neutral name and is never taken for bWalletX.
    const cwi = (window as unknown as { CWI?: WalletInterface }).CWI;
    if (cwi && !cwiIsAnnounced(cwi, [...seen.values()])) {
      out.push(brc100Option(cwi, { id: 'window.CWI', name: seen.size ? 'Another browser wallet' : 'Browser wallet', isBwalletX: false, substrate: 'window.CWI' }));
    }
    const [json, cicada] = await local;
    if (json) out.push(brc100Option(json, { id: 'localhost:3321', name: 'Desktop wallet (localhost:3321)', substrate: 'json-api' }));
    if (cicada) out.push(brc100Option(cicada, { id: 'localhost:3301', name: 'Desktop wallet (localhost:3301)', substrate: 'cicada' }));
  }
  if (o.pairing) out.push(pairingOption(o.pairing));
  out.push(...(o.extra ?? []));
  // bWalletX first, transitional last; otherwise keep discovery order.
  const rank = (w: WalletOption) => (w.isBwalletX ? 0 : w.kind === 'handcash' ? 2 : 1);
  return out.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map((x) => x.w);
}

/** Id of the "Desktop wallet" option (desktopOption). */
export const DESKTOP_OPTION_ID = 'desktop';

/**
 * "Desktop wallet" (Metanet / BSV Desktop on localhost:3321, Cicada on 3301) as an option that looks for the wallet
 * only when connect() runs, i.e. after the user picked it. Nothing touches localhost before that: the first request
 * makes Chrome ask for Local Network Access, which must follow a tap, never a page load. connect() rejects with
 * code NOT_FOUND when neither port answers within `ms`.
 */
export function desktopOption(ms = 1500): WalletOption {
  const opt: WalletOption = {
    id: DESKTOP_OPTION_ID,
    name: 'Desktop wallet',
    kind: 'brc100',
    isBwalletX: false,
    substrate: 'json-api',
    async connect(c) {
      const [json, cicada] = await Promise.all([probe('json-api', ms), probe('Cicada', ms)]);
      const w = json ?? cicada;
      if (!w) throw Object.assign(new Error('No desktop wallet answered on this computer'), { code: 'NOT_FOUND' });
      opt.wallet = w;
      opt.substrate = json ? 'json-api' : 'cicada';
      return brc100Connected(w, opt, c);
    },
  };
  return opt;
}

/**
 * The 0.5.5 rule, kept for `fastPath: false` (0.5.6 sites use decideWallet, which never picks another wallet unasked).
 * Which option to use without showing the picker, or undefined when the user has a real choice.
 *   - nothing found → null;
 *   - one option → it;
 *   - exactly one wallet detected in this browser and no app-supplied option (HandCash, custom) → that wallet, with no
 *     picker: phone pairing is a fallback for "no wallet here", not a second choice;
 *   - only phone pairing → pairing.
 * `force` (picker off): the first detected wallet, else the first non-pairing option, else pairing.
 */
export function autoChoice(list: WalletOption[], force = false): WalletOption | null | undefined {
  // 0.7.0: a desktop wallet on localhost (Metanet on 3321, Cicada on 3301, e.g. found with probeLocal) is never picked
  // without its own tap. It still counts as a choice, so its presence opens the picker instead.
  const auto = list.filter((w) => !isLocalDesktop(w));
  const detected = auto.filter((w) => w.kind === 'brc100');
  const others = auto.filter((w) => w.kind === 'handcash' || w.kind === 'custom');
  const hasLocal = auto.length !== list.length;
  if (force) return detected[0] ?? auto.find((w) => w.kind !== 'pairing') ?? auto[0] ?? null;
  if (!list.length) return null;
  if (list.length === 1) return hasLocal ? undefined : list[0]!;
  if (detected.length === 1 && others.length === 0 && !hasLocal) return detected[0]!;
  if (detected.length === 0 && others.length === 0) return auto[0] ?? undefined;
  return undefined;
}

/**
 * (0.7.0) A desktop wallet reached over localhost (json-api on 3321 = Metanet Desktop, Cicada on 3301): never picked
 * by the button, the fast path or a remembered choice; only by its own tap ("Use Metanet Desktop…").
 */
export function isLocalDesktop(w: Pick<WalletOption, 'id' | 'substrate'>): boolean {
  return w.substrate === 'json-api' || w.substrate === 'cicada' || w.id === 'localhost:3321' || w.id === 'localhost:3301' || w.id === DESKTOP_OPTION_ID;
}
