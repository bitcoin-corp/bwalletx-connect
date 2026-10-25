/**
 * Built-in UI: the pairing QR modal and the wallet picker. Plain DOM, no framework, only created
 * when called in a browser.
 */
import qrcode from 'qrcode-generator';
import type { PairingOptions } from './pair.js';
import type { WalletOption } from './wallets.js';
import { WEB_WALLET_URL } from './element.js';

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

export interface PairingModalOptions {
  title?: string;
  /**
   * 'qr' shows the pairing QR (desktop). 'app' hands off to the bWalletX app on this device: the
   * pairing link is a universal link / Android app link that opens the app, and the bwallet.space
   * page behind it explains what to do when the app is not installed. Default 'auto': 'app' on touch
   * devices, 'qr' elsewhere.
   */
  mode?: 'auto' | 'qr' | 'app';
  /** Called when the user closes the modal (the pairing is then aborted). */
  onCancel?: () => void;
}

/**
 * PairingOptions that show a QR modal. Pass to signInWithBwalletX({ pairing: pairingModal() }) or
 * connectBwalletX. The modal opens when the link is ready and shows the match code. Call `close()`
 * once pairing settles (useBwalletX does this for you); Cancel aborts the pairing.
 */
export function pairingModal(o: PairingModalOptions = {}): PairingOptions & { close(): void } {
  const ac = new AbortController();
  let ui: ReturnType<typeof mount> | null = null;
  let codeEl: HTMLDivElement | null = null;
  const close = () => {
    ui?.close();
    ui = null;
  };
  ac.signal.addEventListener('abort', close);
  return {
    signal: ac.signal,
    close,
    onLink(link) {
      if (typeof document === 'undefined') return;
      close();
      ui = mount();
      const app = o.mode === 'app' || ((o.mode ?? 'auto') === 'auto' && isTouchDevice());
      const h = el('h2', '', o.title ?? 'Connect bWalletX');
      const cancel = el('button', 'bwx-btn', 'Cancel');
      cancel.onclick = () => {
        o.onCancel?.();
        ac.abort();
      };
      codeEl = el('div', 'bwx-code', '');
      codeEl.setAttribute('aria-live', 'polite');
      if (app) {
        // Same device: no QR to scan. The link opens the bWalletX app (universal link); approve there,
        // then come back to this tab, which is still waiting on the pairing channel.
        const p = el('p', '', 'Open bWalletX, approve, then come back to this page.');
        const stack = el('div', 'bwx-stack');
        const open = el('a', 'bwx-btn bwx-primary', 'Open bWalletX');
        open.href = link;
        open.rel = 'noopener';
        const web = el('button', 'bwx-btn', 'Use web.bwalletx.com instead');
        web.onclick = () => {
          void navigator.clipboard?.writeText(link).catch(() => undefined);
          window.open(WEB_WALLET_URL, '_blank', 'noopener');
          p.textContent = 'Link copied. In web.bwalletx.com tap Connect and paste it, then come back here.';
        };
        stack.append(open, web, cancel);
        ui.box.append(h, p, codeEl, stack);
        return;
      }
      const p = el('p', '', 'Scan with bWalletX on your phone, or paste the link into web.bwalletx.com.');
      const qr = el('div', 'bwx-qr');
      qr.innerHTML = qrSvg(link);
      const row = el('div', 'bwx-row');
      const copy = el('button', 'bwx-btn', 'Copy link');
      copy.onclick = () => void navigator.clipboard?.writeText(link).then(() => (copy.textContent = 'Copied'));
      row.append(copy, cancel);
      ui.box.append(h, p, qr, codeEl, row);
    },
    onCode(code) {
      if (codeEl) {
        codeEl.textContent = code;
        const p = ui?.box.querySelector('p');
        if (p) p.textContent = 'Check bWalletX shows the same code, then tap Connect.';
      }
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
