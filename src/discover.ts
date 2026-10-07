import type { WalletInterface } from '@bsv/sdk';

/** Ids bWalletX announces in BRC-100 wallet discovery. */
export const RDNS_EXTENSION = 'com.bwalletx.extension';
export const RDNS_MOBILE = 'space.bwallet.mobile';
export const BWALLETX_RDNS = [RDNS_EXTENSION, RDNS_MOBILE] as const;

export type FoundBy = 'extension' | 'in-app';

export interface FoundWallet {
  wallet: WalletInterface;
  /** 'extension' for the Chrome extension; 'in-app' inside the bWalletX app's own browser. */
  method: FoundBy;
  rdns: string | null;
}

/**
 * Like findBwalletX, but also says which bWalletX answered.
 * Order: a BRC-100 announcement with a bWalletX rdns; then `window.CWI` (set by the in-app
 * browser, and by older builds that do not announce); otherwise null.
 */
export function discoverBwalletX(ms = 1200): Promise<FoundWallet | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: FoundWallet | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('brc100:announceWallet', onAnnounce);
      resolve(r);
    };
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as { info?: { rdns?: string }; wallet?: WalletInterface } | undefined;
      const rdns = d?.info?.rdns ?? '';
      if (d?.wallet && (BWALLETX_RDNS as readonly string[]).includes(rdns)) {
        finish({ wallet: d.wallet, method: rdns === RDNS_EXTENSION ? 'extension' : 'in-app', rdns });
      }
    };
    window.addEventListener('brc100:announceWallet', onAnnounce);
    window.dispatchEvent(new Event('brc100:requestWallet'));
    setTimeout(() => {
      const cwi = (window as unknown as { CWI?: WalletInterface }).CWI;
      finish(cwi ? { wallet: cwi, method: 'in-app', rdns: null } : null);
    }, ms);
  });
}

/**
 * Find bWalletX in this page: the extension on a computer, or the wallet itself when the page is
 * open in bWalletX's in-app browser. Resolves null if nothing answered within `ms`.
 */
export async function findBwalletX(ms = 1200): Promise<WalletInterface | null> {
  return (await discoverBwalletX(ms))?.wallet ?? null;
}
