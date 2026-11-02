/**
 * Built-in UI: the pairing QR modal and the wallet picker. Plain DOM, no framework, only created
 * when called in a browser.
 */
import qrcode from 'qrcode-generator';
import type { PairingOptions } from './pair.js';
import type { WalletOption } from './wallets.js';

const CSS = `
.bwx-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.bwx-box{background:#0b0b0b;color:#f4f1e8;border:1px solid #3a3220;border-radius:16px;width:min(360px,100%);padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.bwx-box h2{margin:0 0 6px;font-size:18px;color:#e8c766}
.bwx-box p{margin:0 0 14px;color:#bdb6a3;font-size:14px}
.bwx-qr{background:#fff;border-radius:12px;padding:12px;display:flex;justify-content:center}
.bwx-qr svg{width:100%;height:auto;max-width:260px}
.bwx-code{margin:14px 0 0;text-align:center;font-size:28px;letter-spacing:.3em;color:#e8c766;font-variant-numeric:tabular-nums}
.bwx-row{display:flex;gap:8px;margin-top:14px}
.bwx-btn{flex:1;border:1px solid #3a3220;background:#15130e;color:#f4f1e8;border-radius:10px;padding:10px 12px;font:inherit;cursor:pointer}
.bwx-btn:hover{border-color:#e8c766}
a.bwx-btn{display:block;text-align:center;text-decoration:none;box-sizing:border-box}
.bwx-primary{background:linear-gradient(180deg,#fcd34d,#f59e0b);color:#000;border:0;font-weight:700;min-height:48px;padding:13px 12px}
.bwx-stack{display:flex;flex-direction:column;gap:8px}
.bwx-list{display:flex;flex-direction:column;gap:8px}
.bwx-opt{display:flex;align-items:center;gap:10px;text-align:left}
.bwx-opt img{width:24px;height:24px;border-radius:6px}
.bwx-tag{margin-left:auto;font-size:11px;color:#8d866f}
.bwx-get{display:block;margin-top:10px;text-align:center;color:#e8c766;font-size:14px;text-decoration:none}
.bwx-get:hover{text-decoration:underline}
.bwx-small{background:none;border:0;color:#8d866f;font:inherit;font-size:13px;text-decoration:underline;cursor:pointer;padding:6px;margin-top:4px}
.bwx-more{margin-top:10px}
.bwx-more[hidden]{display:none}
.bwx-err{color:#f3a7a0}
`;

function mount(): { root: HTMLDivElement; box: HTMLDivElement; close: () => void } {
  const root = document.createElement('div');
  root.className = 'bwx-ov';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const style = document.createElement('style');
  style.textContent = CSS;
  const box = document.createElement('div');
  box.className = 'bwx-box';
  root.append(style, box);
  document.body.appendChild(root);
  return { root, box, close: () => root.remove() };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** An SVG QR code for `text` (error correction M). */
export function qrSvg(text: string): string {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}


/**
 * True on a phone or tablet: a coarse pointer with no hover, or a mobile user agent (iPadOS reports
 * a Mac UA, so touch points count too). Scanning a QR shown on the same screen is impossible there.
 */
export function isTouchDevice(env: { navigator?: Navigator; matchMedia?: (q: string) => MediaQueryList } = globalThis as never): boolean {
  const nav = env.navigator;
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return true;
  try {
    return !!env.matchMedia?.('(pointer: coarse)').matches && !env.matchMedia?.('(hover: hover)').matches;
  } catch {
    return false;
  }
}

/** Where "Don't have it? Get bWalletX" goes on a phone. */
export const START_URL = 'https://bwalletx.com/start';

type DeviceEnv = {
  navigator?: Navigator;
  matchMedia?: (q: string) => MediaQueryList;
  innerWidth?: number;
  CWI?: unknown;
};

/**
 * True when this page is on a phone or tablet with no wallet in the page (no `window.CWI`, which bWalletX's in-app
 * browser injects): a mobile user agent (or iPadOS's Mac UA with touch), or a touch screen with a narrow viewport.
 * There, a QR on the screen is useless (the user can't scan their own phone); "Open in bWalletX" opens the app.
 */
export function isPhoneWithoutWallet(env: DeviceEnv = globalThis as never): boolean {
  if (env.CWI) return false;
  const nav = env.navigator;
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return true;
  let touch = (nav.maxTouchPoints ?? 0) > 0;
  try {
    touch ||= !!env.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    /* no matchMedia */
  }
  const width = typeof env.innerWidth === 'number' ? env.innerWidth : Infinity;
  return touch && width <= 900;
}

/**
 * The pairing link through the app's own scheme: https://www.bwallet.space/pair?<q> → bwalletx://pair?<q>. The
 * bWalletX app (iOS CFBundleURLSchemes / Android intent filter) routes it to the same Connect sheet as a scanned QR
 * (src/mobile/pair/links.ts pairLinkFrom). Unlike the universal link, it never falls back to a web page in Safari.
 */
export function appPairLink(link: string): string {
  try {
    const u = new URL(link);
    return `bwalletx://pair?${u.searchParams}`;
  } catch {
    return link;
  }
}

export interface PairingModalOptions {
  title?: string;
  /**
   * 'qr' shows the pairing QR (desktop). 'app' hands off to the bWalletX app on this device: a big
   * "Open in bWalletX" (bwalletx://pair?…), "Don't have it? Get bWalletX", and the QR only on request
   * ("Show a QR for another device"). Default 'auto': 'app' on a phone or tablet with no wallet in the
   * page (isPhoneWithoutWallet), 'qr' elsewhere.
   */
  mode?: 'auto' | 'qr' | 'app';
  /** Called when the user closes the modal (the pairing is then aborted). */
  onCancel?: () => void;
}

/**
 * PairingOptions that show a QR modal. Pass to signInWithBwalletX({ pairing: pairingModal() }) or
 * connectBwalletX. The modal opens when the link is ready and shows the match code, closes itself once
 * the wallet connects, and offers Try again when a round fails. Cancel aborts the pairing. `close()`
 * is still there for callers that close it themselves.
 */
export function pairingModal(o: PairingModalOptions = {}): PairingOptions & { close(): void } {
  const ac = new AbortController();
  let ui: ReturnType<typeof mount> | null = null;
  let codeEl: HTMLDivElement | null = null;
  let hint: HTMLParagraphElement | null = null;
  let pendingRetry: ((again: boolean) => void) | null = null;
  const app = o.mode === 'app' || ((o.mode ?? 'auto') === 'auto' && typeof window !== 'undefined' && isPhoneWithoutWallet());
  const close = () => {
    ui?.close();
    ui = null;
    codeEl = null;
    hint = null;
  };
  ac.signal.addEventListener('abort', close);
  const cancelButton = () => {
    const cancel = el('button', 'bwx-btn', 'Cancel');
    cancel.onclick = () => {
      const r = pendingRetry;
      pendingRetry = null;
      r?.(false);
      o.onCancel?.();
      ac.abort();
    };
    return cancel;
  };
  const qrBlock = (link: string) => {
    const wrap = el('div');
    const qr = el('div', 'bwx-qr');
    qr.innerHTML = qrSvg(link);
    const copy = el('button', 'bwx-btn', 'Copy link');
    copy.onclick = () => void navigator.clipboard?.writeText(link).then(() => (copy.textContent = 'Copied'));
    wrap.append(qr);
    return { wrap, copy };
  };
  return {
    signal: ac.signal,
    close,
    // On a phone the user leaves for the app and may read the sheet there: give them longer than a QR needs.
    lifetimeS: app ? 240 : undefined,
    onPaired: close,
    retry(err) {
      if (typeof document === 'undefined' || ac.signal.aborted) return Promise.resolve(false);
      close();
      ui = mount();
      const h = el('h2', '', o.title ?? 'Connect bWalletX');
      const p = el('p', 'bwx-err', err.message || 'The connection to bWalletX did not finish.');
      const stack = el('div', 'bwx-stack');
      const again = el('button', 'bwx-btn bwx-primary', 'Try again');
      stack.append(again, cancelButton());
      ui.box.append(h, p, stack);
      return new Promise<boolean>((resolve) => {
        pendingRetry = resolve;
        again.onclick = () => {
          pendingRetry = null;
          close();
          resolve(true);
        };
      });
    },
    onLink(link) {
      if (typeof document === 'undefined') return;
      close();
      ui = mount();
      const h = el('h2', '', o.title ?? 'Connect bWalletX');
      codeEl = el('div', 'bwx-code', '');
      codeEl.setAttribute('aria-live', 'polite');
      if (app) {
        // This IS the phone: no QR to scan. The app scheme opens bWalletX on its Connect sheet; approve there, then
        // come back to this tab, which rejoins the pairing channel and finishes.
        hint = el('p', '', 'Open bWalletX, check the code matches, tap Connect, then come back to this page.');
        const stack = el('div', 'bwx-stack');
        const open = el('a', 'bwx-btn bwx-primary', 'Open in bWalletX');
        open.href = appPairLink(link);
        open.rel = 'noopener';
        const get = el('a', 'bwx-get', "Don't have it? Get bWalletX");
        get.href = START_URL;
        get.target = '_blank';
        get.rel = 'noopener';
        const more = el('div', 'bwx-more');
        more.hidden = true;
        const { wrap, copy } = qrBlock(link);
        const moreNote = el('p', '', 'Scan this with bWalletX on another device, or copy the link into web.bwalletx.com.');
        const moreRow = el('div', 'bwx-row');
        moreRow.append(copy);
        more.append(moreNote, wrap, moreRow);
        const show = el('button', 'bwx-small', 'Show a QR for another device');
        show.onclick = () => {
          more.hidden = !more.hidden;
          show.textContent = more.hidden ? 'Show a QR for another device' : 'Hide the QR';
        };
        stack.append(open, get, show, more, cancelButton());
        ui.box.append(h, hint, codeEl, stack);
        return;
      }
      hint = el('p', '', 'Scan with bWalletX on your phone, or paste the link into web.bwalletx.com.');
      const { wrap, copy } = qrBlock(link);
      const row = el('div', 'bwx-row');
      row.append(copy, cancelButton());
      ui.box.append(h, hint, wrap, codeEl, row);
    },
    onCode(code) {
      if (codeEl) codeEl.textContent = code;
      if (hint) hint.textContent = app ? 'Check bWalletX shows the same code, tap Connect, then come back here.' : 'Check bWalletX shows the same code, then tap Connect.';
    },
  };
}

/** Show the picker; resolves with the chosen option, or null if closed. */
export function pickWallet(options: WalletOption[], o: { title?: string } = {}): Promise<WalletOption | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const ui = mount();
    const done = (w: WalletOption | null) => {
      ui.close();
      resolve(w);
    };
    ui.box.append(el('h2', '', o.title ?? 'Choose a wallet'));
    if (!options.length) ui.box.append(el('p', '', 'No wallet found. Get bWalletX at bwalletx.com.'));
    const list = el('div', 'bwx-list');
    for (const w of options) {
      const b = el('button', 'bwx-btn bwx-opt');
      if (w.icon) {
        const img = el('img');
        img.src = w.icon;
        img.alt = '';
        b.append(img);
      }
      b.append(el('span', '', w.name));
      if (w.kind === 'handcash') b.append(el('span', 'bwx-tag', 'until BRC-100'));
      b.onclick = () => done(w);
      list.append(b);
    }
    const cancel = el('button', 'bwx-btn', 'Cancel');
    cancel.onclick = () => done(null);
    ui.root.onclick = (e) => e.target === ui.root && done(null);
    ui.box.append(list, el('div', 'bwx-row'));
    (ui.box.lastChild as HTMLElement).append(cancel);
  });
}
