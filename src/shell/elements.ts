/**
 * <bwalletx-bar>, <bwalletx-topbar>, <bwalletx-drawer>: the bApp shell drawn on the web.
 * Values match the bWalletX Dock exactly (see docs/BAPP-SHELL in the wallet repo).
 * Framework-free; React wrappers in ./react.ts.
 */
import { SLOT_IDS, isSlotId, slotPath, type BappManifest, type SlotId } from './manifest.js';
import { detectWalletUA, layoutState, walletState } from './wallet.js';

export const TOKENS = {
  barHeight: 88, barBg: '#0A0B0D', hairline: '#1C1C1E', icon: 20, active: '#FFD24D', inactive: '#F2F2F0',
  label: '#98A2B3', bSize: 52, stripHeight: 28, rowHeight: 56, tool: 36, toolRing: '#2A2A2C', toolIcon: '#F5B800',
} as const;

const DEFAULT_LABELS: Record<SlotId, string> = { wallet: 'Wallet', exchange: 'Exchange', b: 'b', feed: 'Feed', chat: 'Chat' };
const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  wallet: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/>'),
  exchange: svg('<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>'),
  feed: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-12 7l-5 1 1-4a8 8 0 1 1 16-4z"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const Base: typeof HTMLElement = typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/** in-wallet attribute: "true" / "false" force it; anything else = auto-detect. */
function inWallet(el: HTMLElement): boolean {
  const a = el.getAttribute('in-wallet');
  if (a === 'true' || a === '') return true;
  if (a === 'false') return false;
  return walletState().inWallet || detectWalletUA().inWallet;
}

function emit(el: HTMLElement, type: string, detail: unknown, cancelable = false): boolean {
  return el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }));
}

/** Fire bapp-navigate; unless prevented (or navigate="manual"), go to the path. */
function navigate(el: HTMLElement, detail: { slot?: SlotId; path: string | null }): void {
  const ok = emit(el, 'bapp-navigate', { ...detail, source: 'web' }, true);
  if (ok && detail.path && el.getAttribute('navigate') !== 'manual') location.assign(detail.path);
}

abstract class ShellElement extends Base {
  protected _manifest: BappManifest | null = null;
  private readonly onWallet = () => this.render();
  private readonly onLayout = () => this.syncLayout();
  /** In the wide layout the wallet draws the sidebar, top bar and sections; bar and topbar hide. */
  protected syncLayout(): void {
    if (layoutState().layout === 'wide') this.setAttribute('data-wide', ''); else this.removeAttribute('data-wide');
  }
  get manifest(): BappManifest | null { return this._manifest; }
  set manifest(m: BappManifest | null) { this._manifest = m; this.render(); }
  connectedCallback(): void {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    window.addEventListener('bapp-wallet', this.onWallet);
    window.addEventListener('bapp-layout', this.onLayout);
    this.syncLayout();
    this.render();
  }
  disconnectedCallback(): void {
    window.removeEventListener('bapp-wallet', this.onWallet);
    window.removeEventListener('bapp-layout', this.onLayout);
  }
  attributeChangedCallback(): void { if (this.shadowRoot) this.render(); }
  protected accent(): string { return this._manifest?.theme?.accent ?? TOKENS.active; }
  abstract render(): void;
}

// ---------------------------------------------------------------- <bwalletx-bar>
const BAR_CSS = `
:host{display:block;--bwx-accent:${TOKENS.active}}
:host([hidden]),:host([data-in-wallet]),:host([data-wide]){display:none!important}
nav{height:${TOKENS.barHeight}px;box-sizing:border-box;background:${TOKENS.barBg};border-top:1px solid ${TOKENS.hairline};
 display:flex;align-items:flex-start;padding:10px 0 env(safe-area-inset-bottom,0);font:10px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
button{all:unset;box-sizing:border-box;flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;
 color:${TOKENS.inactive};-webkit-tap-highlight-color:transparent;touch-action:manipulation}
button:focus-visible{outline:2px solid var(--bwx-accent);outline-offset:2px;border-radius:10px}
button svg{width:${TOKENS.icon}px;height:${TOKENS.icon}px}
.lbl{font-size:10px;color:${TOKENS.label};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
button[aria-current="page"]{color:var(--bwx-accent)}
button[aria-current="page"] .lbl{color:var(--bwx-accent);font-weight:700}
button:disabled{opacity:.35;cursor:default;pointer-events:none}
.b{width:${TOKENS.bSize}px;height:${TOKENS.bSize}px;border-radius:50%;background:#000;border:2px solid var(--bwx-accent);box-sizing:border-box;
 display:grid;place-items:center;font:800 24px/1 Georgia,"Times New Roman",serif;color:var(--bwx-accent);margin-top:-4px}
button[data-slot="b"][aria-current="page"] .b{box-shadow:0 0 0 3px #FFD24D33}
`;

export class BwalletxBarElement extends ShellElement {
  static observedAttributes = ['active', 'in-wallet', 'hidden'];
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private held = false;
  get active(): SlotId | null { const a = this.getAttribute('active'); return isSlotId(a) ? a : null; }
  set active(s: SlotId | null) {
    if (s) this.setAttribute('active', s); else this.removeAttribute('active');
  }
  attributeChangedCallback(name?: string, old?: string | null, val?: string | null): void {
    super.attributeChangedCallback();
    if (name === 'active' && val !== old && isSlotId(val)) emit(this, 'bapp-active', { slot: val });
  }
  render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    if (inWallet(this)) this.setAttribute('data-in-wallet', ''); else this.removeAttribute('data-in-wallet');
    const m = this._manifest;
    const active = this.active;
    const slots = SLOT_IDS.map((id) => {
      const s = m?.slots[id];
      const enabled = !!s?.enabled;
      const label = s?.label ?? DEFAULT_LABELS[id];
      const cur = active === id ? ' aria-current="page"' : '';
      const dis = enabled ? '' : ' disabled aria-disabled="true"';
      if (id === 'b') return `<button type="button" data-slot="b" aria-label="b agent${m ? ` in ${esc(m.name)}` : ''}"${cur}${dis}><span class="b">b</span></button>`;
      return `<button type="button" data-slot="${id}" aria-label="${esc(label)}"${cur}${dis}>${ICONS[id]}<span class="lbl">${esc(label)}</span></button>`;
    }).join('');
    root.innerHTML = `<style>${BAR_CSS}</style><nav part="bar" aria-label="${m ? esc(m.name) : 'App'} navigation" style="--bwx-accent:${this.accent()}">${slots}</nav>`;
    root.querySelectorAll<HTMLButtonElement>('button[data-slot]').forEach((b) => {
      const id = b.dataset.slot as SlotId;
      if (id === 'b') this.wireB(b);
      else b.addEventListener('click', () => this.go(id));
    });
  }
  private go(id: SlotId): void {
    const m = this._manifest;
    if (!m || !m.slots[id]?.enabled) return;
    this.active = id;
    navigate(this, { slot: id, path: slotPath(m, id) });
  }
  /** (b): tap = bapp-b-press, hold (>=450ms) = bapp-b-hold {phase:'start'|'end'}. Hold-to-talk is a later phase. */
  private wireB(b: HTMLButtonElement): void {
    const clear = () => { if (this.holdTimer) clearTimeout(this.holdTimer); this.holdTimer = null; };
    b.addEventListener('pointerdown', () => {
      this.held = false; clear();
      this.holdTimer = setTimeout(() => { this.held = true; emit(this, 'bapp-b-hold', { phase: 'start' }); }, 450);
    });
    const up = () => { clear(); if (this.held) emit(this, 'bapp-b-hold', { phase: 'end' }); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
    b.addEventListener('click', () => {
      if (this.held) { this.held = false; return; }
      if (!this._manifest?.slots.b.enabled) return;
      emit(this, 'bapp-b-press', { path: slotPath(this._manifest, 'b') });
      const p = slotPath(this._manifest, 'b');
      if (p) this.go('b');
    });
  }
}

// ---------------------------------------------------------------- <bwalletx-topbar>
const TOP_CSS = `
:host{display:block;--bwx-accent:${TOKENS.active};font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
:host([hidden]),:host([data-wide]){display:none!important}
.strip{height:${TOKENS.stripHeight}px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;font-size:11px;color:#9a9a9a;background:${TOKENS.barBg}}
::slotted([slot^="strip"]){color:inherit}
.row{height:${TOKENS.rowHeight}px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 12px;background:${TOKENS.barBg};border-bottom:1px solid ${TOKENS.hairline}}
.btn,::slotted([slot="tools"]){all:unset;box-sizing:border-box;width:${TOKENS.tool}px;height:${TOKENS.tool}px;flex:none;border-radius:50%;border:1px solid ${TOKENS.toolRing};
 display:grid;place-items:center;color:${TOKENS.toolIcon};cursor:pointer;-webkit-tap-highlight-color:transparent}
.btn:focus-visible{outline:2px solid var(--bwx-accent);outline-offset:2px}
.btn svg{width:18px;height:18px}
.app{border-color:${TOKENS.toolIcon};background:#1a1405;font-weight:800;font-size:13px;line-height:1;overflow:hidden}
.app img{width:100%;height:100%;object-fit:cover}
.title{flex:1;min-width:0;color:#F2F2F0;font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.title small{display:block;color:#777;font-weight:500;font-size:11px}
.tools{display:flex;gap:8px}
`;

export class BwalletxTopbarElement extends ShellElement {
  static observedAttributes = ['title', 'subtitle', 'in-wallet', 'drawer', 'menu', 'strip', 'hidden'];
  render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const m = this._manifest;
    const wallet = inWallet(this);
    const menu = wallet || this.getAttribute('menu') === 'true';
    const name = this.getAttribute('title') ?? m?.name ?? '';
    const sub = this.getAttribute('subtitle');
    const initials = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'b';
    const icon = m?.icon ? `<img src="${esc(m.icon)}" alt="">` : esc(initials);
    const strip = this.getAttribute('strip') !== 'off';
    root.innerHTML = `<style>${TOP_CSS}</style><header part="topbar" style="--bwx-accent:${this.accent()}">
${strip ? `<div class="strip" part="strip"><slot name="strip-left"></slot><slot name="strip-right"></slot></div>` : ''}
<div class="row" part="row">
${menu ? `<button type="button" class="btn" data-act="menu" aria-label="bWalletX menu">${ICONS.menu}</button>` : ''}
<button type="button" class="btn app" data-act="drawer" aria-label="${esc(name || 'App')} home and sections" aria-haspopup="true">${icon}</button>
<div class="title" part="title">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
<div class="tools"><slot name="tools"></slot>${wallet ? `<button type="button" class="btn" data-act="close" aria-label="Close ${esc(name || 'app')}">${ICONS.close}</button>` : ''}</div>
</div></header>`;
    root.querySelector('[data-act="menu"]')?.addEventListener('click', () => emit(this, 'bapp-menu', {}));
    root.querySelector('[data-act="close"]')?.addEventListener('click', () => emit(this, 'bapp-close', {}));
    root.querySelector('[data-act="drawer"]')?.addEventListener('click', () => {
      if (!emit(this, 'bapp-drawer-toggle', {}, true)) return;
      const id = this.getAttribute('drawer');
      const d = (id ? document.getElementById(id) : document.querySelector('bwalletx-drawer')) as BwalletxDrawerElement | null;
      d?.toggle();
    });
  }
}

// ---------------------------------------------------------------- <bwalletx-drawer>
const DRAWER_CSS = `
:host{position:fixed;inset:var(--bwx-drawer-top,84px) 0 var(--bwx-drawer-bottom,88px) 0;z-index:50;display:none;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
:host([open]){display:block}
.scrim{position:absolute;inset:0;background:#0009}
nav{position:absolute;top:0;left:0;bottom:0;width:min(78%,320px);box-sizing:border-box;background:#0d0e10;border-right:1px solid ${TOKENS.hairline};padding:14px;overflow:auto}
h4{margin:10px 0 6px;font-size:11px;color:#777;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
a{display:flex;align-items:center;gap:10px;padding:11px 10px;border-radius:10px;color:#F2F2F0;text-decoration:none;font-size:15px}
a img{width:20px;height:20px}
a[aria-current="page"]{background:#1a1405;color:var(--bwx-accent)}
a:focus-visible{outline:2px solid var(--bwx-accent)}
hr{border:0;border-top:1px solid ${TOKENS.hairline};margin:10px 0}
.back{color:${TOKENS.toolIcon}}
`;

export class BwalletxDrawerElement extends ShellElement {
  static observedAttributes = ['open', 'current', 'in-wallet'];
  get open(): boolean { return this.hasAttribute('open'); }
  set open(v: boolean) { this.toggleAttribute('open', v); }
  toggle(force?: boolean): void { this.open = force ?? !this.open; }
  render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const m = this._manifest;
    const cur = this.getAttribute('current') ?? (typeof location !== 'undefined' ? location.pathname : '/');
    const items = m ? [{ label: 'Home', path: m.home }, ...m.drawer] : [];
    const links = items.map((it, i) => `<a href="${esc(it.path)}" data-i="${i}"${it.path === cur ? ' aria-current="page"' : ''}>${'icon' in it && it.icon ? `<img src="${esc(it.icon)}" alt="">` : ''}${esc(it.label)}</a>`).join('');
    const back = inWallet(this) ? `<hr><a href="#" class="back" data-act="close">← Back to bWalletX</a>` : '';
    root.innerHTML = `<style>${DRAWER_CSS}</style><div class="scrim" part="scrim"></div><nav part="drawer" aria-label="${m ? esc(m.name) : 'App'} sections" style="--bwx-accent:${this.accent()}"><h4>${m ? esc(m.name) : ''}</h4>${links}${back}</nav>`;
    root.querySelector('.scrim')!.addEventListener('click', () => this.toggle(false));
    root.querySelectorAll<HTMLAnchorElement>('a[data-i]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const it = items[Number(a.dataset.i)]!;
      this.toggle(false);
      navigate(this, { path: it.path });
    }));
    root.querySelector('[data-act="close"]')?.addEventListener('click', (e) => { e.preventDefault(); this.toggle(false); emit(this, 'bapp-close', {}); });
  }
}

/** Register the three elements (idempotent). */
export function defineBappShell(): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get('bwalletx-bar')) customElements.define('bwalletx-bar', BwalletxBarElement);
  if (!customElements.get('bwalletx-topbar')) customElements.define('bwalletx-topbar', BwalletxTopbarElement);
  if (!customElements.get('bwalletx-drawer')) customElements.define('bwalletx-drawer', BwalletxDrawerElement);
}

/** Give every shell element on the page the same manifest. */
export function applyManifest(m: BappManifest, root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement & { manifest: BappManifest | null }>('bwalletx-bar,bwalletx-topbar,bwalletx-drawer').forEach((el) => { el.manifest = m; });
}
