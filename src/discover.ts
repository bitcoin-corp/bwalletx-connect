import { WalletClient, XDM, type WalletInterface } from '@bsv/sdk';

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

/**
 * The only parents that may answer as bWalletX over XDM (security audit 25 Oct 2026). Without this, any page that
 * framed a site using this package became "the wallet": it saw every call (payments, sign-in challenges) and could
 * answer with a fake txid. The wallet's own frames: the web wallet, bwallet.space, the iOS/Android app shells and
 * the Chrome extension. Payments must still be checked on your server (verifyPayment), never trusted from the page.
 */
export const BWALLETX_PARENT_ORIGINS: readonly string[] = [
  'https://web.bwalletx.com',
  'https://desktop.bwalletx.com',
  'https://bwalletx.com',
  'https://www.bwallet.space',
  'https://bwallet.space',
  'capacitor://localhost', // iOS app shell
  'https://localhost', // Android app shell
  'tauri://localhost', // bWalletX Desktop (macOS)
  'https://tauri.localhost', // bWalletX Desktop (Windows)
  'chrome-extension://bombmmcjghjdlbmcclnhjodgcelnehgl', // bWalletX for Chrome (fixed id)
];

/** The parent frame's origin, as the browser reports it (ancestorOrigins, else the referrer), or null. */
export const parentOrigin = (): string | null => {
  try {
    const anc = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (anc && anc.length > 0) return anc[0] ?? null;
    if (!document.referrer) return null;
    // Not URL.origin: it is "null" for non-special schemes (capacitor:, chrome-extension:) in some engines.
    const u = new URL(document.referrer);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
};

/**
 * The parent frame's wallet over BRC-100 XDM, or null when the parent is not bWalletX (BWALLETX_PARENT_ORIGINS) or
 * does not answer within `ms`. Messages go to that exact origin and only its answers are taken.
 */
export async function probeXdm(ms = 1200, allowed: readonly string[] = BWALLETX_PARENT_ORIGINS): Promise<WalletInterface | null> {
  const origin = parentOrigin();
  if (!origin || !allowed.includes(origin)) return null;
  try {
    const w = new WalletClient(new XDM(origin) as unknown as WalletInterface);
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
