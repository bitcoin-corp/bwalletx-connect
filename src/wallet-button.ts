/**
 * <bwalletx-button>: THE one wallet control for a site's nav (owner, 28 Oct 2026: no more duplicate Connect / Get
 * bWalletX / handle badges side by side). It renders exactly one thing, by state:
 *
 *   no wallet in this browser      → "Get bWalletX" (a link: extension / iphone / android / get, by platform)
 *   a wallet here, not connected   → "Connect bWalletX" (the extension, the in-app browser, or a QR to the phone)
 *   connected                      → the $handle chip (gold b + handle); click to disconnect
 *
 * Phones can't be told apart from "not installed" (the app is a separate browser), so they get Connect: it pairs.
 * The look is the official button (SIGNIN_CSS + the gold b mark from <bwalletx-signin>).
 *
 * GUARD: one per page. A second <bwalletx-button> hides itself, and legacy controls inside the same header/nav
 * (`[data-bwx-connect]`, `.nav-connect`, `.nav-acct`, links to bwalletx.com/get) are hidden, each with a
 * console warning. Use only this element; don't add your own Get or Connect links.
 *
 * Attributes: size (sm | md | lg, default sm), get-url (overrides the platform link), discover-ms (default 800),
 * lookup-url (handle lookup, default pay.bwallet.space; "off" to skip).
 * Events (bubble, composed): bwalletx-connected { identityKey }, bwalletx-disconnected.
 */
import { discoverBwalletX } from './discover.js';
import { clearPairing } from './pair.js';
import { connectBwalletX } from './signin.js';
import { pairingModal } from './modal.js';
import { markSvg, SIGNIN_CSS } from './element.js';

export const BUTTON_TAG = 'bwalletx-button';
export const CONNECTED_KEY = 'bwx:connected';
const LOOKUP = 'https://pay.bwallet.space/api/paymail/lookup?key=';
const LEGACY = '[data-bwx-connect], .nav-connect, .nav-acct, a[href^="https://bwalletx.com/get"], a[href^="https://www.bwalletx.com/get"]';

export type ButtonState = 'checking' | 'none' | 'available' | 'connecting' | 'connected';

/** Where "Get bWalletX" goes for this user agent. */
export function getUrlFor(ua: string, touchMac = false): string {
  if (/iPhone|iPad|iPod/i.test(ua) || (touchMac && /Macintosh/.test(ua))) return 'https://bwalletx.com/iphone';
  if (/Android/i.test(ua)) return 'https://bwalletx.com/android';
  if (/Chrome\//.test(ua) && !/Edg\/|OPR\//.test(ua)) return 'https://bwalletx.com/extension';
  return 'https://bwalletx.com/get';
}

/** What a signed-out button should say before/after discovery. */
export function stateFor(o: { connected: boolean; found: boolean | null; phone: boolean }): ButtonState {
  if (o.connected) return 'connected';
  if (o.found === null) return o.phone ? 'available' : 'checking';
  return o.found || o.phone ? 'available' : 'none';
}

/** $alice for alice@bwalletx.com, other paymails in full, else a short key. */
export function handleLabel(key: string, paymail: string | null): string {
  if (paymail && /@bwalletx\.com$/i.test(paymail)) return '$' + paymail.split('@')[0];
  if (paymail) return paymail;
  return key.slice(0, 6) + '…' + key.slice(-4);
}

const CHIP_CSS = `
a.b,button.b{all:unset;box-sizing:border-box}
.chip{background:#0b0b0c;color:#ffd24d;border:1px solid rgba(255,210,77,.45);box-shadow:none}
.chip:hover{background:#151517;border-color:#ffd24d}
.chip .dot{width:8px;height:8px;border-radius:50%;background:#34d399;flex:none}
.txt b{overflow:hidden;text-overflow:ellipsis;max-width:min(40vw,220px)}
:host(:not([size])) button,:host(:not([size])) a.btn,:host([size=sm]) a.btn{padding:6px 12px 6px 6px;border-radius:8px;font-size:13px;gap:8px;min-height:36px}
:host(:not([size])) .mark,:host([size=sm]) a.btn .mark{width:22px;height:22px}
a.btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:12px;cursor:pointer;
 padding:16px 20px;border-radius:12px;font-size:16px;font-weight:700;line-height:1.2;background:linear-gradient(180deg,#fcd34d,#f59e0b);color:#000;
 box-shadow:0 10px 15px -3px rgba(245,158,11,.2),0 4px 6px -4px rgba(245,158,11,.2)}
a.btn:hover{background:linear-gradient(180deg,#fde68a,#fbbf24)}
a.btn:focus-visible{outline:2px solid #b45309;outline-offset:3px}
:host([size=md]) a.btn{padding:10px 16px;border-radius:10px;font-size:15px;gap:10px}
`;

const live = new Set<HTMLElement>();

function createClass(): CustomElementConstructor {
  return class BwalletxButtonElement extends HTMLElement {
    #root: ShadowRoot;
    #state: ButtonState = 'checking';
    #key: string | null = null;
    #paymail: string | null = null;
    #duplicate = false;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: 'open' });
    }

    get state(): ButtonState { return this.#state; }
    get identityKey(): string | null { return this.#key; }

    connectedCallback() {
      if (live.size && ![...live].includes(this)) {
        this.#duplicate = true;
        this.hidden = true;
        console.warn('[bwalletx] A second <bwalletx-button> is on this page; it is hidden. Use one per page.');
        return;
      }
      live.add(this);
      this.#hideLegacy();
      const saved = this.#saved();
      const phone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      this.#set(stateFor({ connected: false, found: null, phone }));
      const ms = Number(this.getAttribute('discover-ms')) || 800;
      void discoverBwalletX(ms).then(async (f) => {
        if (!this.isConnected) return;
        if (f && saved) {
          try {
            const { publicKey } = await f.wallet.getPublicKey({ identityKey: true });
            this.#connected(publicKey);
            return;
          } catch { /* the wallet said no: offer Connect */ }
        }
        if (this.#state !== 'connected' && this.#state !== 'connecting') this.#set(stateFor({ connected: false, found: !!f, phone }));
      }).catch(() => { if (this.#state === 'checking') this.#set('none'); });
    }

    disconnectedCallback() { if (!this.#duplicate) live.delete(this); }

    #saved(): string | null { try { return localStorage.getItem(CONNECTED_KEY); } catch { return null; } }
    #store(k: string | null) { try { if (k) localStorage.setItem(CONNECTED_KEY, k); else localStorage.removeItem(CONNECTED_KEY); } catch { /* private mode */ } }

    #hideLegacy() {
      const scope = this.closest('header, nav') ?? document;
      for (const el of Array.from(scope.querySelectorAll<HTMLElement>(LEGACY))) {
        if (el === this || el.contains(this)) continue;
        el.hidden = true;
        el.style.setProperty('display', 'none', 'important');
        console.warn('[bwalletx] Hid a second wallet control next to <bwalletx-button>:', el, '. Use only <bwalletx-button>; don\'t add your own Get or Connect links.');
      }
    }

    #emit(type: string, detail?: unknown) { this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }

    #set(s: ButtonState) { this.#state = s; this.setAttribute('state', s); this.#render(); }

    #connected(key: string) {
      this.#key = key; this.#store(key); this.#set('connected');
      this.#emit('bwalletx-connected', { identityKey: key });
      const lookup = this.getAttribute('lookup-url');
      if (lookup === 'off') return;
      void fetch((lookup ?? LOOKUP) + encodeURIComponent(key)).then((r) => (r.ok ? r.json() : null)).then((j: { paymail?: unknown } | null) => {
        if (j && typeof j.paymail === 'string' && this.#key === key) { this.#paymail = j.paymail; this.#render(); }
      }).catch(() => undefined);
    }

    async connect() {
      if (this.#state === 'connecting' || this.#state === 'connected') return;
      const modal = pairingModal({ title: 'Connect bWalletX' });
      this.#set('connecting');
      try {
        const { wallet } = await connectBwalletX({ pairing: modal });
        const { publicKey } = await wallet.getPublicKey({ identityKey: true });
        this.#connected(publicKey);
      } catch (e) {
        if ((e as { code?: string })?.code === 'NOT_FOUND') this.#set('none');
        else { this.#set('available'); if ((e as { name?: string })?.name !== 'AbortError') console.warn('[bwalletx] connect:', e); }
      } finally {
        try { modal.close(); } catch { /* closed */ }
      }
    }

    disconnect() {
      try { clearPairing(); } catch { /* none */ }
      try { window.postMessage({ type: 'bwallet:disconnect' }, location.origin); } catch { /* no window */ }
      this.#key = null; this.#paymail = null; this.#store(null);
      this.#set('available');
      this.#emit('bwalletx-disconnected');
    }

    #render() {
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      const size = this.getAttribute('size') ?? 'sm';
      const px = size === 'lg' ? 20 : size === 'md' ? 17 : 15;
      const mark = `<span class="mark" part="mark">${markSvg(px)}</span>`;
      const css = `<style>${SIGNIN_CSS}${CHIP_CSS}</style>`;
      const s = this.#state;
      if (s === 'none') {
        const href = this.getAttribute('get-url') ?? getUrlFor(navigator.userAgent, (navigator.maxTouchPoints ?? 0) > 1);
        this.#root.innerHTML = `${css}<a class="btn" part="button" href="${esc(href)}" target="_blank" rel="noopener">${mark}<span class="txt" part="text"><b part="label">Get bWalletX</b></span></a>`;
        return;
      }
      if (s === 'connected' && this.#key) {
        const name = handleLabel(this.#key, this.#paymail);
        this.#root.innerHTML = `${css}<button type="button" class="chip" part="button chip" title="Connected to bWalletX. Click to disconnect." aria-label="Connected as ${esc(name)}. Disconnect">${mark}<span class="txt" part="text"><b part="label">${esc(name)}</b></span><span class="dot" aria-hidden="true"></span></button>`;
        this.#root.querySelector('button')!.onclick = () => this.disconnect();
        return;
      }
      const busy = s === 'connecting' || s === 'checking';
      this.#root.innerHTML = `${css}<button type="button" part="button"${busy ? ' aria-busy="true"' : ''}>${busy ? '<span class="mark" part="mark"><span class="spin" aria-hidden="true"></span></span>' : mark}<span class="txt" part="text"><b part="label">${s === 'connecting' ? 'Connecting…' : 'Connect bWalletX'}</b></span></button>`;
      this.#root.querySelector('button')!.onclick = () => void this.connect();
    }
  };
}

/** Register <bwalletx-button> (idempotent; no-op on a server). */
export function defineBwalletxButton(tag = BUTTON_TAG): void {
  if (typeof customElements === 'undefined' || customElements.get(tag)) return;
  customElements.define(tag, createClass());
}

/** Test hook: forget which button owns the page. */
export function _resetBwalletxButtons() { live.clear(); }
