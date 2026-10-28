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
 * Default wait for a wallet that has not answered yet, ms. bWalletX for Chrome answers `brc100:requestWallet`
 * synchronously and the in-app browser sets `window.CWI` before the page runs, so a found wallet resolves at once;
 * this is only how long "nothing here" takes before the pairing QR shows. Was 1200 (0.5.3 and earlier).
 */
export const DEFAULT_DISCOVER_MS = 300;

/**
 * Like findBwalletX, but also says which bWalletX answered.
 * Order: a BRC-100 announcement with a bWalletX rdns (answered at once by the extension); then `window.CWI` (set by
 * the in-app browser, and by older builds that do not announce), taken straight away; then, only when framed, the
 * parent's XDM answer (probed in parallel with the wait). Otherwise null after `ms`.
 */
export function discoverBwalletX(ms = DEFAULT_DISCOVER_MS): Promise<FoundWallet | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: FoundWallet | null) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
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
    const cwiNow = (): boolean => {
      const cwi = (window as unknown as { CWI?: WalletInterface }).CWI;
      if (cwi) finish({ wallet: cwi, method: 'in-app', rdns: null });
      return !!cwi;
    };
    window.addEventListener('brc100:announceWallet', onAnnounce);
    window.dispatchEvent(new Event('brc100:requestWallet'));
    if (done || cwiNow()) return;
    // Inside bWalletX's in-wallet frame nothing is injected into the page: the wallet answers BRC-100 XDM
    // (postMessage to the parent) instead. Only tried when framed, and only kept if the parent answers.
    // The parent may take a moment to answer, so it gets at least the old 1200 ms; unframed pages never wait on it.
    if (isFramed()) {
      void probeXdm(Math.max(ms, 1200)).then((w) => finish(w ? { wallet: w, method: 'in-app', rdns: null } : null));
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!cwiNow()) finish(null);
    }, ms);
  });
}

/**
 * Find bWalletX in this page: the extension on a computer, or the wallet itself when the page is
 * open in bWalletX's in-app browser. Resolves null if nothing answered within `ms`.
 */
export async function findBwalletX(ms = DEFAULT_DISCOVER_MS): Promise<WalletInterface | null> {
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

let warmedAt = 0;

/**
 * Wake the wallet before the click (call on pointerenter / focus / touchstart of your Connect button). Chrome stops an
 * idle extension worker after ~30 s, and a cold worker needs 1-3 s to reopen the wallet; this sends a liveness call
 * (isAuthenticated: never shows a prompt, never reveals a key) so that work starts while the pointer is on its way.
 * At most once every 20 s. Does nothing when no bWalletX is in the page.
 */
export function prewarmBwalletX(): void {
  if (typeof window === 'undefined' || Date.now() - warmedAt < 20_000) return;
  warmedAt = Date.now();
  void discoverBwalletX(0).then((f) => {
    if (f && f.method === 'extension') void f.wallet.isAuthenticated({}).catch(() => {});
  });
}

/** Prewarm on hover, keyboard focus and touch. Returns a function that removes the listeners. */
export function bindPrewarm(el: EventTarget): () => void {
  const on = () => prewarmBwalletX();
  const evs = ['pointerenter', 'focus', 'touchstart'];
  for (const e of evs) el.addEventListener(e, on, { passive: true });
  return () => evs.forEach((e) => el.removeEventListener(e, on));
}
