/**
 * <bwalletx-signin>: the standard "Sign in with bWalletX" button as a framework-free web component.
 *
 * Design reference: the gold button in bit-sign's sign-in card (src/components/BwalletSignIn.tsx):
 * amber-300 → amber-500 vertical gradient, 12px radius, 16px/20px padding, 16px bold black label,
 * 11px subtitle at 60% black, a black 28px circle holding the gold "b", amber shadow.
 *
 * Attributes (all optional):
 *   size          lg (default) | md | sm | icon
 *   theme         gold (default) | dark | light
 *   label         signin (default) | continue | connect
 *   brand         bWalletX (default) | bWallet   (store edition text)
 *   subtitle      on | off | <custom text>. Default on for lg/md, off for sm/icon and for brand="bWallet"
 *   full-width    stretch to the container
 *   loading       show the spinner and set aria-busy
 *   disabled      disable the button
 *   challenge-url / verify-url   run the sign-in flow on click (POST JSON, as in the README)
 *   get-url       where "Get bWalletX" points. Default https://bwalletx.com/get
 *   web-url       the web wallet. Default https://web.bwalletx.com
 *   discover-ms   how long to wait for the wallet to answer. Default 1200
 *   href          plain link mode: navigate here on click
 *   authorize-url (+ client-id, redirect-uri, scope)  OAuth mode, for auth.bwalletx.com once it exists
 *
 * Events (bubble, composed):
 *   bwalletx-signin     on every click, before anything else. Cancelable: preventDefault() stops the
 *                       built-in behaviour so you can run your own flow.
 *   bwalletx-signed-in  detail { identityKey, method, nonce, signature, response }
 *   bwalletx-not-found  no bWalletX answered; the "Get bWalletX" row is shown
 *   bwalletx-error      detail { error }
 */
import { discoverBwalletX } from './discover.js';
import { signInWithBwalletX, type Challenge } from './signin.js';

export const SIGNIN_TAG = 'bwalletx-signin';
export const GET_URL = 'https://bwalletx.com/get';
export const WEB_WALLET_URL = 'https://web.bwalletx.com';

export type SigninSize = 'lg' | 'md' | 'sm' | 'icon';
export type SigninTheme = 'gold' | 'dark' | 'light';
export type SigninLabel = 'signin' | 'continue' | 'connect';
export type SigninBrand = 'bWalletX' | 'bWallet';

const VERBS: Record<SigninLabel, string> = { signin: 'Sign in with', continue: 'Continue with', connect: 'Connect' };

/** The visible label for a label/brand pair, e.g. "Sign in with bWalletX". */
export function signinText(label: SigninLabel = 'signin', brand: SigninBrand = 'bWalletX'): string {
  return `${VERBS[label] ?? VERBS.signin} ${brand}`;
}

let uid = 0;
/** The gold "b" (bwalletx-site/logo.svg). Ids are unique per copy so several marks can share a page. */
export function markSvg(px = 20): string {
  const n = ++uid;
  return `<svg viewBox="23 8 74 100" width="${Math.round(px * 0.74)}" height="${px}" aria-hidden="true" focusable="false"><defs><linearGradient id="bwxg${n}" gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="105"><stop offset="0" stop-color="#FFE58A"/><stop offset=".55" stop-color="#FFD24D"/><stop offset="1" stop-color="#C98F00"/></linearGradient><mask id="bwxh${n}"><rect width="140" height="140" fill="#fff"/><circle cx="60" cy="72" r="15" fill="#000"/></mask></defs><g fill="url(#bwxg${n})" mask="url(#bwxh${n})"><polygon points="45,12 45,76 27,76 27,30"/><circle cx="60" cy="72" r="33"/></g></svg>`;
}

export const SIGNIN_CSS = `
:host{display:inline-block;vertical-align:middle;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
:host([full-width]){display:block;width:100%}
:host([hidden]){display:none}
button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:12px;width:100%;cursor:pointer;
 padding:16px 20px;border-radius:12px;font-size:16px;font-weight:700;line-height:1.2;text-align:left;
 background:linear-gradient(180deg,#fcd34d,#f59e0b);color:#000;
 box-shadow:0 10px 15px -3px rgba(245,158,11,.2),0 4px 6px -4px rgba(245,158,11,.2);
 transition:background .15s,transform .1s,box-shadow .15s,border-color .15s;-webkit-tap-highlight-color:transparent}
button:hover{background:linear-gradient(180deg,#fde68a,#fbbf24)}
button:active{transform:translateY(1px);background:linear-gradient(180deg,#fbbf24,#d97706)}
button:focus-visible{outline:2px solid #b45309;outline-offset:3px}
button:disabled{opacity:.6;cursor:not-allowed;transform:none}
button[aria-busy=true]{cursor:wait}
.mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:50%;background:#000}
.txt{display:flex;flex-direction:column;align-items:flex-start;min-width:0}
.txt b{font-weight:700;white-space:nowrap}
.txt small{font-size:11px;font-weight:500;color:rgba(0,0,0,.65);white-space:nowrap}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,210,77,.35);border-top-color:#ffd24d;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){button{transition:none}button:active{transform:none}.spin{animation:none;border-color:#ffd24d;border-right-color:transparent}}
/* sizes */
:host([size=md]) button{padding:10px 16px;border-radius:10px;font-size:15px;gap:10px}
:host([size=md]) .mark{width:24px;height:24px}
:host([size=md]) .txt small{font-size:10.5px}
:host([size=sm]) button{padding:6px 12px 6px 6px;border-radius:8px;font-size:13px;gap:8px;min-height:36px}
:host([size=sm]) .mark{width:22px;height:22px}
:host([size=icon]) button{width:48px;height:48px;padding:0;border-radius:50%;gap:0}
:host([size=icon]) .mark{width:34px;height:34px}
/* themes */
:host([theme=dark]) button{background:#0a0a0a;color:#fafafa;border:1px solid #3f3f46;box-shadow:none}
:host([theme=dark]) button:hover{background:#18181b;border-color:rgba(251,191,36,.6)}
:host([theme=dark]) button:active{background:#000}
:host([theme=dark]) button:focus-visible{outline-color:#fcd34d}
:host([theme=dark]) .mark{box-shadow:inset 0 0 0 1px #3f3f46}
:host([theme=dark]) .txt small{color:rgba(255,255,255,.65)}
:host([theme=light]) button{background:#fff;color:#09090b;border:1px solid #d4d4d8;box-shadow:0 1px 2px rgba(0,0,0,.06)}
:host([theme=light]) button:hover{background:#fafafa;border-color:#f59e0b}
:host([theme=light]) button:active{background:#f4f4f5}
:host([theme=light]) .txt small{color:#52525b}
/* not found */
.nf{margin-top:8px;font-size:12px;line-height:1.4;color:#71717a;text-align:center}
.nf a{color:inherit;font-weight:600;text-decoration:underline;text-underline-offset:2px}
.nf a:focus-visible{outline:2px solid #b45309;outline-offset:2px;border-radius:2px}
:host([theme=dark]) .nf,:host-context(.dark) .nf{color:#a1a1aa}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

/** Optional OAuth parameters for authorize-url mode. auth.bwalletx.com is planned, not live. */
export interface AuthorizeParams { authorizeUrl: string; clientId?: string | null; redirectUri?: string | null; scope?: string | null }

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build an OAuth 2.1 authorization-code + S256 PKCE redirect URL, and keep the verifier, state and
 * nonce in sessionStorage under "bwalletx:oauth" for your callback page. Matches the plan in
 * bit-sign docs/SIGN-IN-WITH-BWALLETX.md. The provider is not live yet.
 */
export async function buildAuthorizeUrl(p: AuthorizeParams): Promise<string> {
  const rnd = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const verifier = rnd(32);
  const state = rnd(16);
  const nonce = rnd(16);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const u = new URL(p.authorizeUrl, typeof location !== 'undefined' ? location.href : undefined);
  const set = (k: string, v: string | null | undefined) => { if (v) u.searchParams.set(k, v); };
  set('response_type', 'code');
  set('client_id', p.clientId);
  set('redirect_uri', p.redirectUri);
  set('scope', p.scope || 'openid profile');
  set('state', state);
  set('nonce', nonce);
  set('code_challenge', b64url(digest));
  set('code_challenge_method', 'S256');
  try { sessionStorage.setItem('bwalletx:oauth', JSON.stringify({ verifier, state, nonce })); } catch { /* storage blocked */ }
  return u.toString();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const OBSERVED = ['size', 'theme', 'label', 'brand', 'subtitle', 'loading', 'disabled', 'full-width', 'aria-label', 'get-url', 'web-url'];

/** The element class. Created lazily so importing this module on a server is harmless. */
function createClass(): CustomElementConstructor {
  return class BwalletxSigninElement extends HTMLElement {
    static get observedAttributes() { return OBSERVED; }
    #root: ShadowRoot;
    #notFound = false;
    #busy = false;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback() { this.#render(); }
    attributeChangedCallback() { if (this.isConnected) this.#render(); }

    /** The inner <button>, for focus() and tests. */
    get button(): HTMLButtonElement | null { return this.#root.querySelector('button'); }
    get notFound() { return this.#notFound; }

    focus(opts?: FocusOptions) { this.button?.focus(opts); }

    #attr(name: string) { return this.getAttribute(name); }

    #render() {
      const size = (this.#attr('size') ?? 'lg') as SigninSize;
      const brand: SigninBrand = this.#attr('brand') === 'bWallet' ? 'bWallet' : 'bWalletX';
      const text = signinText((this.#attr('label') ?? 'signin') as SigninLabel, brand);
      const subAttr = this.#attr('subtitle');
      const subDefault = brand === 'bWalletX' && (size === 'lg' || size === 'md') ? 'also works with bWallet' : null;
      const subtitle = subAttr === null || subAttr === '' || subAttr === 'on' ? (subAttr === 'on' ? 'also works with bWallet' : subDefault)
        : subAttr === 'off' ? null : subAttr;
      const loading = this.hasAttribute('loading') || this.#busy;
      const disabled = this.hasAttribute('disabled');
      const markPx = size === 'icon' ? 24 : size === 'sm' ? 15 : size === 'md' ? 17 : 20;
      const aria = this.#attr('aria-label') ?? (subtitle && size !== 'icon' ? `${text}, ${subtitle}` : text);
      const getUrl = this.#attr('get-url') ?? GET_URL;
      const webUrl = this.#attr('web-url') ?? WEB_WALLET_URL;

      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      const label = size === 'icon' ? '' : `<span class="txt" part="text"><b part="label">${esc(text)}</b>${subtitle ? `<small part="subtitle">${esc(subtitle)}</small>` : ''}</span>`;
      const mark = loading ? '<span class="spin" aria-hidden="true"></span>' : markSvg(markPx);
      const nf = this.#notFound
        ? `<p class="nf" part="not-found" role="status">bWalletX wasn't found in this browser. <a href="${esc(getUrl)}" target="_blank" rel="noopener">Get ${brand}</a> or <a href="${esc(webUrl)}" target="_blank" rel="noopener">use the web wallet</a>.</p>`
        : '';
      this.#root.innerHTML = `<style>${SIGNIN_CSS}</style><button type="button" part="button" aria-label="${esc(aria)}" title="${esc(subtitle ? `${text} (${subtitle})` : text)}"${disabled ? ' disabled' : ''}${loading ? ' aria-busy="true"' : ''}><span class="mark" part="mark">${mark}</span>${label}</button>${loading ? '<span class="sr" role="status">Connecting to bWalletX…</span>' : ''}${nf}`;
      this.button!.addEventListener('click', () => void this.#click());
    }

    #emit(type: string, detail?: unknown, cancelable = false) {
      return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }));
    }

    #setBusy(on: boolean) { this.#busy = on; this.#render(); }

    async #click() {
      if (this.hasAttribute('disabled') || this.hasAttribute('loading') || this.#busy) return;
      if (!this.#emit('bwalletx-signin', { element: this }, true)) return;

      const href = this.#attr('href');
      const authorizeUrl = this.#attr('authorize-url');
      if (authorizeUrl) {
        location.assign(await buildAuthorizeUrl({ authorizeUrl, clientId: this.#attr('client-id'), redirectUri: this.#attr('redirect-uri'), scope: this.#attr('scope') }));
        return;
      }
      if (href) { location.assign(href); return; }

      const challengeUrl = this.#attr('challenge-url');
      if (!challengeUrl) return; // event-only mode: the page runs its own flow

      this.#notFound = false;
      this.#setBusy(true);
      try {
        const ms = Number(this.#attr('discover-ms')) || 1200;
        const found = await discoverBwalletX(ms);
        if (!found) {
          this.#notFound = true;
          this.#emit('bwalletx-not-found');
          return;
        }
        const r = await signInWithBwalletX({ wallet: found.wallet, challenge: (identityKey) => postJson<Challenge>(challengeUrl, { identityKey }) });
        const verifyUrl = this.#attr('verify-url');
        const response = verifyUrl ? await postJson(verifyUrl, { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature }) : null;
        this.#emit('bwalletx-signed-in', { identityKey: r.identityKey, method: found.method, nonce: r.nonce, signature: r.signature, response });
      } catch (error) {
        this.#emit('bwalletx-error', { error });
      } finally {
        this.#setBusy(false);
      }
    }
  };
}

/** Register <bwalletx-signin> (once). Safe to call on a server: it does nothing there. */
export function defineBwalletxSignin(tag = SIGNIN_TAG): CustomElementConstructor | undefined {
  if (typeof window === 'undefined' || typeof customElements === 'undefined') return undefined;
  const existing = customElements.get(tag);
  if (existing) return existing;
  const C = createClass();
  customElements.define(tag, C);
  return C;
}
