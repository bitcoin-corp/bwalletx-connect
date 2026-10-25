import { WalletClient, type WalletInterface } from '@bsv/sdk';

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
      if (cwi) return finish({ wallet: cwi, method: 'in-app', rdns: null });
      // Inside bWalletX's in-wallet frame nothing is injected into the page: the wallet answers BRC-100 XDM
      // (postMessage to the parent) instead. Only tried when framed, and only kept if the parent answers.
      if (!isFramed()) return finish(null);
      void probeXdm(ms).then((w) => finish(w ? { wallet: w, method: 'in-app', rdns: null } : null));
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

const isFramed = (): boolean => {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
};

/** The parent frame's wallet over BRC-100 XDM, or null when it does not answer within `ms`. */
export async function probeXdm(ms = 1200): Promise<WalletInterface | null> {
  try {
    const w = new WalletClient('XDM');
    const ok = await Promise.race([
      w.isAuthenticated({}).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
    ]);
    return ok ? w : null;
  } catch {
    return null;
  }
}
