const CSS = `
.bwx-signin{display:inline-flex;align-items:center;gap:12px;min-height:48px;padding:10px 22px 10px 10px;border:0;border-radius:12px;cursor:pointer;background:linear-gradient(180deg,#fcd34d,#f59e0b);color:#000;text-align:left;font:700 16px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(245,158,11,.2)}
.bwx-signin:hover{background:linear-gradient(180deg,#fde68a,#fbbf24)}
.bwx-signin:focus-visible{outline:2px solid #ffd24d;outline-offset:3px}
.bwx-signin:disabled{opacity:.6;cursor:wait}
.bwx-signin .bwx-mark{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#000;flex:none}
.bwx-signin small{display:block;font-size:11px;font-weight:500;color:rgba(0,0,0,.6)}`;

export const LOGO_URL = 'https://bwalletx.com/logo.svg';

export interface ButtonOptions {
  /** Second line under the label. Default "also works with bWallet". false hides it. */
  subtitle?: string | false;
  onClick?: (button: HTMLButtonElement) => void;
}

/** Put the gold "Sign in with bWalletX" button into `el` (replacing its contents). */
export function renderButton(el: HTMLElement | string, opts: ButtonOptions = {}): HTMLButtonElement {
  const host = typeof el === 'string' ? document.querySelector<HTMLElement>(el) : el;
  if (!host) throw new Error(`renderButton: no element ${String(el)}`);
  if (!document.getElementById('bwx-signin-css')) {
    const style = document.createElement('style');
    style.id = 'bwx-signin-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bwx-signin';
  const mark = document.createElement('span');
  mark.className = 'bwx-mark';
  const img = document.createElement('img');
  img.src = LOGO_URL;
  img.alt = '';
  img.width = 15;
  img.height = 20;
  mark.appendChild(img);
  const label = document.createElement('span');
  label.className = 'bwx-label';
  label.textContent = 'Sign in with bWalletX';
  const sub = opts.subtitle === undefined ? 'also works with bWallet' : opts.subtitle;
  if (sub) {
    const small = document.createElement('small');
    small.textContent = sub;
    label.appendChild(small);
  }
  b.append(mark, label);
  if (opts.onClick) b.addEventListener('click', () => opts.onClick!(b));
  host.replaceChildren(b);
  return b;
}
