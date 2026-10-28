/**
 * Every wallet the user could connect with, behind one interface. BRC-100 first: bWalletX, then any
 * other wallet that announces itself (Yours, Metanet, ...), the in-app browser, optional localhost
 * desktop wallets, phone pairing, and app-supplied adapters (e.g. the transitional HandCash one).
 */
import { WalletClient, type WalletInterface } from '@bsv/sdk';
import { BWALLETX_RDNS, RDNS_EXTENSION } from './discover.js';
import { pairBwalletX, restorePairing, type PairingOptions } from './pair.js';
import type { PaySource } from './pay.js';

export type WalletKind = 'brc100' | 'pairing' | 'handcash' | 'custom';

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
  connect(): Promise<ConnectedWallet>;
}

async function brc100Connected(wallet: WalletInterface, o: Pick<WalletOption, 'id' | 'kind'>): Promise<ConnectedWallet> {
  await wallet.waitForAuthentication({}).catch(() => {});
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  return { wallet, payer: wallet, identityKey: publicKey, optionId: o.id, kind: o.kind };
}

/** Wrap any BRC-100 wallet as a picker option. */
export function brc100Option(wallet: WalletInterface, info: { id: string; name: string; icon?: string; rdns?: string; isBwalletX?: boolean }): WalletOption {
  const opt: WalletOption = {
    id: info.id,
    name: info.name,
    icon: info.icon,
    rdns: info.rdns,
    kind: 'brc100',
    isBwalletX: info.isBwalletX ?? false,
    connect: () => brc100Connected(wallet, opt),
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
    async connect() {
      const p = typeof pairing === 'function' ? pairing() : pairing;
      const w = (await restorePairing(p)) ?? (await pairBwalletX(p));
      return brc100Connected(w, opt);
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
   * Also probe desktop wallets on localhost (Metanet / json-api on 3321, Cicada on 3301).
   * Off by default: some browsers prompt for local-network access.
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
      seen.set(rdns, brc100Option(d.wallet, { id: rdns, rdns, name: NAMES[rdns] ?? d.info?.name ?? rdns, icon: d.info?.icon, isBwalletX: isB }));
    };
    window.addEventListener('brc100:announceWallet', onAnnounce);
    window.dispatchEvent(new Event('brc100:requestWallet'));
    const local = o.probeLocal ? Promise.all([probe('json-api', ms), probe('Cicada', ms)]) : Promise.resolve([null, null]);
    // Wallets answer requestWallet synchronously; once one has, a short grace catches any slower sibling.
    await new Promise((r) => setTimeout(r, seen.size > 0 || (window as unknown as { CWI?: unknown }).CWI ? Math.min(ms, 50) : ms));
    window.removeEventListener('brc100:announceWallet', onAnnounce);
    out.push(...seen.values());
    const cwi = (window as unknown as { CWI?: WalletInterface }).CWI;
    if (cwi && ![...seen.values()].some((x) => x.rdns === 'space.bwallet.mobile')) {
      out.push(brc100Option(cwi, { id: 'window.CWI', name: 'This app’s wallet', isBwalletX: false }));
    }
    const [json, cicada] = await local;
    if (json) out.push(brc100Option(json, { id: 'localhost:3321', name: 'Desktop wallet (localhost:3321)' }));
    if (cicada) out.push(brc100Option(cicada, { id: 'localhost:3301', name: 'Desktop wallet (localhost:3301)' }));
  }
  if (o.pairing) out.push(pairingOption(o.pairing));
  out.push(...(o.extra ?? []));
  // bWalletX first, transitional last; otherwise keep discovery order.
  const rank = (w: WalletOption) => (w.isBwalletX ? 0 : w.kind === 'handcash' ? 2 : 1);
  return out.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map((x) => x.w);
}
