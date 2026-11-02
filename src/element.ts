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
 *   label         signin (default) | continue | connect | get ("Get bWalletX") | play ("Play with bWalletX")
 *   brand         bWalletX (default) | bWallet   (store edition text)
 *   subtitle      on | off | <custom text>. Default on for lg/md, off for sm/icon and for brand="bWallet"
 *   full-width    stretch to the container
 *   loading       show the spinner and set aria-busy
 *   disabled      disable the button
 *   challenge-url / verify-url   run the sign-in flow on click (POST JSON, as in the README)
 *   require-token / min / min-bps with challenge-url: run the $403 access flow instead; emits
 *                                bwalletx-access-granted or bwalletx-access-denied { code, have, need }
 *   get-url       where "Get bWalletX" points. Default https://bwalletx.com/get
 *   web-url       the web wallet. Default https://web.bwalletx.com
 *   discover-ms   how long to wait for a wallet that has not answered. Default 300
 *   session-url   GET → { identityKey, handle?, paymail? }: restores the signed-in badge on load, no wallet prompt
 *   logout-url    POST on Disconnect (clears the session cookie)
 *   lookup-url    paymail lookup by key for the badge. Default pay.bwallet.space; "off" to skip
 *   stateless     keep the pre-0.5.5 behaviour: a plain button that never shows the signed-in badge
 *   state         drive it yourself (BwalletxSignin inside BwalletXProvider does): signed-out | restoring | pending |
 *                 signed-in | error, with identity-key, paymail, handle, avatar-url and error. The element then
 *                 only emits events; it never changes its own state.
 *   href          plain link mode: navigate here on click
 *   authorize-url (+ client-id, redirect-uri, scope)  OAuth mode, for auth.bwalletx.com once it exists
 *
 * Events (bubble, composed):
 *   bwalletx-signin     on every click, before anything else. Cancelable: preventDefault() stops the
 *                       built-in behaviour so you can run your own flow.
 *   bwalletx-signed-in  detail { identityKey, method, nonce, signature, response }
 *   bwalletx-not-found  no bWalletX answered; the "Get bWalletX" row is shown
 *   bwalletx-error      detail { error }
 *   bwalletx-disconnect Disconnect chosen in the badge menu. Cancelable: preventDefault() and sign out yourself
 *                       (BwalletXProvider does). Otherwise logout-url is posted and the element shows signed out.
 *   bwalletx-signed-out after the element signed out by itself
 *
 * States (one element, the whole experience): signed out (the button) → pending ("Approve in bWalletX…" and one
 * plain line: what signing in shares) → signed in (a badge: bAvatar, $handle or short key, gold dot; its menu has
 * Copy paymail/key and Disconnect) or an error (one line plus Retry; a no in the wallet reads "Sign-in cancelled").
 */
import { bindPrewarm, discoverBwalletX, DEFAULT_DISCOVER_MS } from './discover.js';
import { signInAndVerify, type Challenge } from './signin.js';
import { requestAccess, type AccessChallengeLike } from './access-client.js';
import { AccessError } from './access.js';
import { accountLabel, avatarUrlFor, copyText, lookupPaymail, rememberIdentity, rememberedIdentity, signInErrorText } from './account.js';

export const SIGNIN_TAG = 'bwalletx-signin';
export const GET_URL = 'https://bwalletx.com/get';
export const WEB_WALLET_URL = 'https://web.bwalletx.com';

export type SigninSize = 'lg' | 'md' | 'sm' | 'icon';
export type SigninTheme = 'gold' | 'dark' | 'light';
export type SigninLabel = 'signin' | 'continue' | 'connect' | 'get' | 'play';
export type SigninBrand = 'bWalletX' | 'bWallet';

const VERBS: Record<SigninLabel, string> = { signin: 'Sign in with', continue: 'Continue with', connect: 'Connect', get: 'Get', play: 'Play with' };

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
/* pending: one plain line under the button */
.note{margin:8px 0 0;width:0;min-width:100%;font-size:12px;line-height:1.4;color:#71717a;text-align:center;overflow-wrap:break-word}
:host([theme=dark]) .note,:host-context(.dark) .note{color:#a1a1aa}
/* error: one line plus Retry */
.err{margin:0 0 8px;width:0;min-width:100%;font-size:13px;font-weight:600;line-height:1.4;color:#b91c1c;text-align:center;overflow-wrap:anywhere}
:host([theme=dark]) .err,:host-context(.dark) .err{color:#fca5a5}
/* signed in: the badge */
button.chip{display:inline-flex;align-items:center;justify-content:flex-start;gap:10px;width:auto;max-width:100%;padding:5px 14px 5px 5px;border-radius:999px;
 background:#0b0b0c;color:#ffd24d;border:1px solid rgba(255,210,77,.55);box-shadow:none;font-size:15px}
button.chip:hover{background:#151517;border-color:#ffd24d}
button.chip:active{background:#000;transform:none}
button.chip:focus-visible{outline:2px solid #ffd24d;outline-offset:3px}
:host([theme=light]) button.chip{background:#fff;color:#09090b;border-color:#f59e0b}
:host([theme=light]) button.chip:hover{background:#fffbeb}
:host([full-width]) button.chip{width:100%}
.av{position:relative;flex:none;display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;overflow:hidden;
 background:radial-gradient(circle at 30% 30%,#ffe27a,#f5b800 55%,#b88600);color:#000;font-weight:800;font-size:14px}
.av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:min(52vw,260px)}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:#ffd24d;box-shadow:0 0 0 3px rgba(255,210,77,.22)}
:host([size=sm]) button.chip{font-size:13px;padding:3px 12px 3px 3px;gap:8px}
:host([size=sm]) .av{width:26px;height:26px}
:host([size=icon]) button.chip{width:48px;height:48px;padding:0;justify-content:center}
:host([size=icon]) .name,:host([size=icon]) .dot{display:none}
:host([size=icon]) .av{width:40px;height:40px}
`;

/** The badge menu. Rendered in a body-level portal (position: fixed), so overflow:hidden parents never clip it. */
export const MENU_CSS = `
:host{all:initial}
.menu{position:fixed;z-index:2147483600;box-sizing:border-box;min-width:200px;padding:6px;border-radius:14px;background:#0b0b0c;color:#ffd24d;
 border:1px solid rgba(255,210,77,.55);box-shadow:0 12px 32px rgba(0,0,0,.45);font:600 14px/1.3 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.who{padding:8px 10px 10px;font-size:12px;font-weight:500;color:#e7d9a8;overflow-wrap:anywhere;border-bottom:1px solid rgba(255,210,77,.3);margin-bottom:4px}
.item{all:unset;box-sizing:border-box;display:block;width:100%;padding:11px 10px;border-radius:10px;cursor:pointer;color:#ffd24d}
.item:hover,.item:focus-visible{background:#ffd24d;color:#000;outline:none}
.tip{position:fixed;z-index:2147483600;box-sizing:border-box;padding:8px 12px;border-radius:10px;background:#0b0b0c;color:#e7d9a8;
 border:1px solid rgba(255,210,77,.4);box-shadow:0 8px 24px rgba(0,0,0,.35);font:500 12px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
`;

export type SigninState = 'signed-out' | 'restoring' | 'pending' | 'signed-in' | 'error';

/** The account the badge shows. */
export interface SigninAccount {
  identityKey: string;
  paymail?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
}

/** The one plain line shown while the wallet sheet is up. */
export const PENDING_NOTE = 'Sign in: shares only your public identity key, moves no money';
export const PENDING_LABEL = 'Approve in bWalletX…';

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
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
}

/** POST that returns the body even on 4xx, so access error codes reach requestAccess. */
async function postAccess(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json().catch(() => ({ error: 'bad_request', message: `HTTP ${res.status}` }));
}

const OBSERVED = ['size', 'theme', 'label', 'brand', 'subtitle', 'loading', 'disabled', 'full-width', 'aria-label', 'get-url', 'web-url', 'state', 'identity-key', 'paymail', 'handle', 'avatar-url', 'error'];
const STATES: readonly SigninState[] = ['signed-out', 'restoring', 'pending', 'signed-in', 'error'];

/** The element class. Created lazily so importing this module on a server is harmless. */
function createClass(): CustomElementConstructor {
  return class BwalletxSigninElement extends HTMLElement {
    static get observedAttributes() { return OBSERVED; }
    #root: ShadowRoot;
    #notFound = false;
    #busy = false;
    #phase: SigninState = 'signed-out';
    #account: SigninAccount | null = null;
    #error = '';
    #restored = false;
    #menu: { host: HTMLElement; close: (focusChip?: boolean) => void } | null = null;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.#render();
      void this.#restore();
    }
    disconnectedCallback() { this.#menu?.close(false); this.#hideTip(); }
    attributeChangedCallback() { if (this.isConnected) this.#render(); }

    /** The inner <button>, for focus() and tests. */
    get button(): HTMLButtonElement | null { return this.#root.querySelector('button'); }
    get notFound() { return this.#notFound; }
    /** The state shown now (the `state` attribute when set, else the element's own). */
    get state(): SigninState {
      const a = this.#attr('state') as SigninState | null;
      return a && STATES.includes(a) ? a : this.#phase;
    }
    /** The signed-in account, or null. */
    get account(): SigninAccount | null {
      if (!this.#controlled) return this.#account;
      const identityKey = this.#attr('identity-key');
      return identityKey ? { identityKey, paymail: this.#attr('paymail'), handle: this.#attr('handle'), avatarUrl: this.#attr('avatar-url') } : null;
    }
    /** True while the menu is open (tests). */
    get menuOpen(): boolean { return !!this.#menu; }

    focus(opts?: FocusOptions) { this.button?.focus(opts); }

    get #controlled() { return this.hasAttribute('state'); }
    get #stateful() { return !this.hasAttribute('stateless'); }

    #attr(name: string) { return this.getAttribute(name); }

    /** Restore the badge from session-url once, with no wallet call. */
    async #restore() {
      const url = this.#attr('session-url');
      if (this.#restored || !url || this.#controlled || !this.#stateful) return;
      this.#restored = true;
      this.#set('restoring');
      try {
        const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
        const j = (await r.json().catch(() => ({}))) as { identityKey?: string | null; handle?: string | null; paymail?: string | null };
        if (this.#phase !== 'restoring') return; // a click got there first
        if (j.identityKey) this.#signedIn({ identityKey: j.identityKey, handle: j.handle ?? null, paymail: j.paymail ?? null });
        else this.#set('signed-out');
      } catch {
        if (this.#phase === 'restoring') this.#set('signed-out');
      }
    }

    #set(p: SigninState) {
      this.#phase = p;
      if (p !== 'signed-in') this.#menu?.close(false);
      this.#render();
    }

    #signedIn(a: SigninAccount) {
      this.#account = a;
      this.#error = '';
      this.#set('signed-in');
      const lookup = this.#attr('lookup-url');
      if (!a.paymail && lookup !== 'off') {
        void lookupPaymail(a.identityKey, lookup ?? undefined).then((pm) => {
          if (pm && this.#account?.identityKey === a.identityKey && !this.#account.paymail) {
            this.#account = { ...this.#account, paymail: pm };
            this.#render();
          }
        });
      }
    }

    #render() {
      const size = (this.#attr('size') ?? 'lg') as SigninSize;
      const brand: SigninBrand = this.#attr('brand') === 'bWallet' ? 'bWallet' : 'bWalletX';
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
      const state = this.state;
      const acct = this.account;

      if (state === 'signed-in' && acct) {
        this.#hideTip();
        const name = accountLabel(acct);
        const avatar = acct.avatarUrl ?? avatarUrlFor(acct.identityKey);
        const initial = (name.replace(/^\$/, '').charAt(0) || 'b').toUpperCase();
        this.#root.innerHTML = `<style>${SIGNIN_CSS}</style><button type="button" class="chip" part="button chip" aria-haspopup="menu" aria-expanded="${this.#menu ? 'true' : 'false'}" aria-label="Signed in with bWalletX as ${esc(name)}. Account menu" title="Signed in as ${esc(name)}"><span class="av" part="avatar" aria-hidden="true">${esc(initial)}${avatar ? `<img alt="" src="${esc(avatar)}" referrerpolicy="no-referrer">` : ''}</span><span class="name" part="label">${esc(name)}</span><span class="dot" part="dot" aria-hidden="true"></span></button>`;
        const img = this.#root.querySelector('img');
        if (img) img.addEventListener('error', () => img.remove(), { once: true });
        const chip = this.button!;
        chip.addEventListener('click', () => (this.#menu ? this.#menu.close(true) : this.#openMenu()));
        chip.addEventListener('keydown', (e) => {
          if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !this.#menu) {
            e.preventDefault();
            this.#openMenu();
          }
        });
        return;
      }

      const pending = state === 'pending';
      const restoring = state === 'restoring';
      const error = state === 'error';
      const text = pending ? PENDING_LABEL : error ? 'Retry' : signinText((this.#attr('label') ?? 'signin') as SigninLabel, brand);
      const subAttr = this.#attr('subtitle');
      const subDefault = brand === 'bWalletX' && (size === 'lg' || size === 'md') ? 'also works with bWallet' : null;
      const subtitle = pending || error ? null : subAttr === null || subAttr === '' || subAttr === 'on' ? (subAttr === 'on' ? 'also works with bWallet' : subDefault)
        : subAttr === 'off' ? null : subAttr;
      const loading = this.hasAttribute('loading') || this.#busy || pending || restoring;
      const disabled = this.hasAttribute('disabled');
      const markPx = size === 'icon' ? 24 : size === 'sm' ? 15 : size === 'md' ? 17 : 20;
      const aria = pending ? PENDING_LABEL : this.#attr('aria-label') ?? (subtitle && size !== 'icon' ? `${text}, ${subtitle}` : text);
      const getUrl = this.#attr('get-url') ?? GET_URL;
      const webUrl = this.#attr('web-url') ?? WEB_WALLET_URL;
      const errText = error ? (this.#controlled ? this.#attr('error') : this.#error) || 'Sign-in failed' : '';

      const label = size === 'icon' ? '' : `<span class="txt" part="text"><b part="label">${esc(text)}</b>${subtitle ? `<small part="subtitle">${esc(subtitle)}</small>` : ''}</span>`;
      const mark = loading ? '<span class="spin" aria-hidden="true"></span>' : markSvg(markPx);
      const nf = this.#notFound
        ? `<p class="nf" part="not-found" role="status">bWalletX wasn't found in this browser. <a href="${esc(getUrl)}" target="_blank" rel="noopener">Get ${brand}</a> or <a href="${esc(webUrl)}" target="_blank" rel="noopener">use the web wallet</a>.</p>`
        : '';
      const err = error ? `<p class="err" part="error" role="alert">${esc(errText)}</p>` : '';
      const compact = size === 'sm' || size === 'icon';
      const note = pending && !compact ? `<p class="note" part="note">${esc(PENDING_NOTE)}</p>` : '';
      const status = pending ? `<span class="sr" role="status">${esc(PENDING_LABEL)}</span>` : loading ? '<span class="sr" role="status">Connecting to bWalletX…</span>' : '';
      this.#root.innerHTML = `<style>${SIGNIN_CSS}</style>${err}<button type="button" part="button" aria-label="${esc(aria)}" title="${esc(subtitle ? `${text} (${subtitle})` : text)}"${disabled ? ' disabled' : ''}${loading ? ' aria-busy="true"' : ''}><span class="mark" part="mark">${mark}</span>${label}</button>${status}${note}${nf}`;
      this.button!.addEventListener('click', () => void this.#click());
      bindPrewarm(this.button!);
      // A nav-sized button has no room for the line: it shows in a body-level tip under the button instead, so an
      // overflow:hidden header can't clip it and the header doesn't grow.
      if (pending && compact) this.#showTip(PENDING_NOTE);
      else this.#hideTip();
    }

    #tip: HTMLElement | null = null;

    #showTip(text: string) {
      const b = this.button;
      if (!b || typeof document === 'undefined') return;
      if (!this.#tip) {
        const host = document.createElement('div');
        host.setAttribute('data-bwalletx-tip', '');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${MENU_CSS}</style><div class="tip" role="note"></div>`;
        document.body.appendChild(host);
        this.#tip = host;
      }
      const tip = this.#tip.shadowRoot!.querySelector<HTMLElement>('.tip')!;
      tip.textContent = text;
      const r = b.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth || 360;
      const width = Math.min(280, vw - 32);
      tip.style.width = `${width}px`;
      tip.style.left = `${Math.max(16, Math.min(r.right - width, vw - width - 16))}px`;
      tip.style.top = `${r.bottom + 8}px`;
    }

    #hideTip() {
      this.#tip?.remove();
      this.#tip = null;
    }

    #openMenu() {
      const acct = this.account;
      const chip = this.button;
      if (!acct || !chip || typeof document === 'undefined') return;
      const name = accountLabel(acct);
      const host = document.createElement('div');
      host.setAttribute('data-bwalletx-menu', '');
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = MENU_CSS;
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'bWalletX account');
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = `Signed in as ${acct.paymail || name}`;
      const item = (text: string, run: (b: HTMLButtonElement) => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'item';
        b.setAttribute('role', 'menuitem');
        b.tabIndex = -1;
        b.textContent = text;
        b.addEventListener('click', () => run(b));
        return b;
      };
      const copyWhat = acct.paymail ? 'paymail' : 'key';
      const copy = item(`Copy ${copyWhat}`, (b) => {
        void copyText(acct.paymail || acct.identityKey).then((ok) => {
          b.textContent = ok ? 'Copied' : `Copy ${copyWhat}`;
          setTimeout(() => close(true), ok ? 600 : 0);
        });
      });
      const out = item('Disconnect', () => {
        close(false);
        void this.signOut();
      });
      menu.append(who, copy, out);
      root.append(style, menu);
      document.body.appendChild(host);

      // Fixed position under the chip (above when there is no room), clamped to the viewport: never clipped by an
      // overflow:hidden parent, never wider than a phone screen.
      const place = () => {
        const r = chip.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 360;
        const vh = window.innerHeight || document.documentElement.clientHeight || 640;
        const width = Math.min(260, vw - 32);
        menu.style.width = `${width}px`;
        const left = Math.max(16, Math.min(r.right - width, vw - width - 16));
        menu.style.left = `${left}px`;
        const h = menu.offsetHeight || 150;
        const below = r.bottom + 8;
        menu.style.top = `${below + h > vh && r.top - 8 - h > 0 ? r.top - 8 - h : below}px`;
      };
      place();
      const items = [copy, out];
      const focusAt = (i: number) => items[(i + items.length) % items.length]!.focus();
      const onKey = (e: KeyboardEvent) => {
        const i = items.indexOf(root.activeElement as HTMLButtonElement);
        if (e.key === 'Escape') { e.preventDefault(); close(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
        else if (e.key === 'End') { e.preventDefault(); focusAt(items.length - 1); }
        else if (e.key === 'Tab') close(false);
      };
      const onDown = (e: Event) => {
        const path = (e as Event & { composedPath?: () => EventTarget[] }).composedPath?.() ?? [];
        if (!path.includes(host) && !path.includes(this)) close(false);
      };
      const onMove = () => close(false);
      menu.addEventListener('keydown', onKey);
      document.addEventListener('pointerdown', onDown, true);
      window.addEventListener('resize', onMove);
      window.addEventListener('scroll', place, true);
      const close = (focusChip = false) => {
        if (this.#menu?.host !== host) return;
        this.#menu = null;
        menu.removeEventListener('keydown', onKey);
        document.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('resize', onMove);
        window.removeEventListener('scroll', place, true);
        host.remove();
        this.button?.setAttribute('aria-expanded', 'false');
        if (focusChip) this.button?.focus();
      };
      this.#menu = { host, close };
      chip.setAttribute('aria-expanded', 'true');
      focusAt(0);
    }

    /**
     * Disconnect: emits bwalletx-disconnect (cancelable). Unless a listener cancels it (BwalletXProvider signs out
     * itself) or the element is driven by `state`, posts logout-url and shows signed out.
     */
    async signOut(): Promise<void> {
      this.#menu?.close(false);
      if (!this.#emit('bwalletx-disconnect', { element: this, account: this.account }, true)) return;
      if (this.#controlled) return;
      const url = this.#attr('logout-url');
      if (url) await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
      this.#account = null;
      this.#set('signed-out');
      this.#emit('bwalletx-signed-out');
      this.button?.focus();
    }

    #emit(type: string, detail?: unknown, cancelable = false) {
      return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }));
    }

    async #click() {
      if (this.hasAttribute('disabled') || this.hasAttribute('loading') || this.#busy || this.state === 'pending') return;
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

      const own = this.#stateful && !this.#controlled;
      this.#notFound = false;
      this.#busy = true;
      if (own) this.#set('pending');
      else this.#render();
      try {
        const ms = Number(this.#attr('discover-ms')) || DEFAULT_DISCOVER_MS;
        const found = await discoverBwalletX(ms);
        if (!found) {
          this.#notFound = true;
          if (own) this.#phase = 'signed-out';
          this.#emit('bwalletx-not-found');
          if (this.#attr('require-token')) this.#emit('bwalletx-access-denied', { code: 'not_installed', message: 'No wallet found' });
          return;
        }
        const requireToken = this.#attr('require-token');
        if (requireToken) {
          if (own) this.#phase = 'signed-out'; // the access flow reports through its own events
          // $403 gate. The server's own config is authoritative; these attributes are passed along as a hint.
          const verifyUrl = this.#attr('verify-url');
          const min = this.#attr('min');
          const minBps = this.#attr('min-bps');
          const hint = { token: { id: requireToken, ...(minBps ? { minBps: Number(minBps) } : { min: min ?? '1' }) } };
          try {
            const a = await requestAccess({
              wallet: found.wallet,
              challenge: (identityKey) => postJson<AccessChallengeLike>(challengeUrl, { identityKey, require: hint }),
              verify: verifyUrl ? (response) => postAccess(verifyUrl, response) : undefined,
            });
            this.#emit('bwalletx-access-granted', { identityKey: a.response.identityKey, response: a.verified });
          } catch (e) {
            const err = e instanceof AccessError ? e : new AccessError('bad_request', String(e));
            this.#emit('bwalletx-access-denied', { code: err.code, message: err.message, have: err.have, need: err.need });
          }
          return;
        }
        // One wallet sheet: the challenge first (no key), then the key and the signature together; a repeat sign-in
        // reuses the key that signed in here last time, so it is the signature alone.
        const verifyUrl = this.#attr('verify-url');
        const { result: r, verified } = await signInAndVerify({
          wallet: found.wallet,
          identityKeyHint: verifyUrl ? rememberedIdentity() : undefined,
          challenge: (identityKey) => postJson<Challenge>(challengeUrl, identityKey ? { identityKey } : {}),
          verify: async (res) => (verifyUrl ? await postJson<Record<string, unknown>>(verifyUrl, { identityKey: res.identityKey, nonce: res.nonce, signature: res.signature }) : {}),
        });
        if (verifyUrl) rememberIdentity(r.identityKey);
        const response = verifyUrl ? (verified as { handle?: string; paymail?: string }) : null;
        if (own) this.#signedIn({ identityKey: r.identityKey, handle: response?.handle ?? null, paymail: response?.paymail ?? null });
        this.#emit('bwalletx-signed-in', { identityKey: r.identityKey, method: found.method, nonce: r.nonce, signature: r.signature, response });
      } catch (error) {
        if (own) {
          this.#error = signInErrorText(error);
          this.#phase = 'error';
        }
        this.#emit('bwalletx-error', { error });
      } finally {
        this.#busy = false;
        this.#render();
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
