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
 *   other-wallets auto (default) | on | off. A small "Other wallets" link under the button that opens the chooser
 *                 (phone QR, other browser wallets, desktop wallets). auto: shown at lg/md when the element runs the
 *                 sign-in (challenge-url) or follows a provider; always offered in the not-found row unless off
 *   remember      on (default) | off. (0.6.0) Remember the wallet TYPE picked on this origin (never a key): the next
 *                 tap goes straight to it. Disconnect forgets it. Nothing fires on load
 *   switch-note   auto (default) | on | off. (0.6.0) "Some features need bWalletX · Switch" under the button when the
 *                 remembered wallet isn't bWalletX (auto: lg/md), and in the signed-in menu
 *   metanet       auto (default) | on | off. (0.7.0) "Use Metanet Desktop or another BRC-100 wallet · Metanet Desktop
 *                 must be running on this computer": a link under the button that connects to localhost:3321 (pinned
 *                 json-api, never 'auto') on its own tap only. auto: lg/md when the element signs in or follows a
 *                 provider. Never on a phone or inside a frame. With Metanet remembered here, the element makes ONE
 *                 silent attempt per page load (2 s, identity keys already known here only) and shows "Not you? Use
 *                 another wallet", which forgets it
 *   wallet-type   (driven by a provider) the connected or remembered wallet type, for the Switch note
 *   session-url   GET → { identityKey, handle?, paymail? }: restores the signed-in badge on load, no wallet prompt
 *   logout-url    POST on Disconnect (clears the session cookie). REQUIRED with verify-url (0.7.0): "Not you?" and
 *                 Disconnect end a session the verify route created through it (a dev console.warn when missing)
 *   lookup-url    paymail lookup by key for the badge. Default pay.bwallet.space; "off" to skip
 *   stateless     keep the pre-0.5.5 behaviour: a plain button that never shows the signed-in badge
 *   state         drive it yourself (BwalletxSignin inside BwalletXProvider does): signed-out | restoring | pending |
 *                 signed-in | error, with identity-key, paymail, handle, avatar-url and error. The element then
 *                 only emits events; it never changes its own state.
 *   href          plain link mode: navigate here on click
 *   authorize-url (+ client-id, redirect-uri, scope)  OAuth mode, for auth.bwalletx.com once it exists
 *
 * Wallet choice (0.5.6): bWalletX in this browser (its own announcement, never window.CWI) → straight to its sheet,
 * no chooser. Other wallets here but no bWalletX → the chooser, "Get bWalletX" first; another wallet is used only
 * when picked. Nothing here → the not-found row. Nothing probes localhost until "Desktop wallet" is tapped.
 *
 * Events (bubble, composed):
 *   bwalletx-signin     on every click, before anything else, detail { element, mode } (mode: 'signin',
 *                       'chooser' from "Other wallets", 'bwalletx' from "Switch", 'metanet' from the Metanet link). Cancelable: preventDefault() stops the built-in behaviour so
 *                       you can run your own flow.
 *   bwalletx-attempt    once per attempt: { walletType, substrate, outcome, ms }. No keys or addresses.
 *   bwalletx-signed-in  detail { identityKey, method, nonce, signature, response }
 *   bwalletx-not-found  no bWalletX answered; the "Get bWalletX" row is shown
 *   bwalletx-error      detail { error }
 *   bwalletx-disconnect Disconnect chosen in the badge menu. Cancelable: preventDefault() and sign out yourself
 *                       (BwalletXProvider does). Otherwise logout-url is posted and the element shows signed out.
 *   bwalletx-signed-out after the element signed out by itself
 *   bwalletx-not-you    "Not you? Use another wallet" (0.7.0). Cancelable: BwalletXProvider forgets the choice itself
 *
 * States (one element, the whole experience): signed out (the button) → pending ("Approve in bWalletX…" and one
 * plain line: what signing in shares) → signed in (a badge: bAvatar, $handle or short key, gold dot; its menu has
 * Copy paymail/key and Disconnect) or an error (one line plus Retry; a no in the wallet reads "Sign-in cancelled").
 */
import { bindPrewarm, discoverBwalletX, DEFAULT_DISCOVER_MS, RDNS_EXTENSION, RDNS_MOBILE } from './discover.js';
import { brc100Option, discoverWallets, type WalletOption } from './wallets.js';
import {
  attemptFor, forgetWalletChoice, hasBwalletX, isExplicitPick, matchRemembered, needsBwalletX, otherDetected, outcomeOf,
  rememberWalletChoice, rememberedWalletChoice, substrateOf, tapGoesElsewhere, walletTypeOf, BWALLETX_TYPE, type AttemptOutcome, type ChoiceReason,
} from './choice.js';
import { chooseWallet, pairingModal } from './modal.js';
import { signInAndVerify, type Challenge } from './signin.js';
import { requestAccess, type AccessChallengeLike } from './access-client.js';
import { AccessError } from './access.js';
import { accountLabel, avatarUrlFor, copyText, lookupPaymail, rememberIdentity, rememberedIdentity, signInErrorText } from './account.js';
import { openForSignIn, runSilentMetanet } from './connect-flow.js';
import { hasReturnFragment, onPageWake, resumeReturnedPairing } from './pair.js';
import {
  metanetOffered, metanetOption, rememberKnownIdentityKey, silentAttemptUsed, METANET_LABEL, METANET_NOTE, METANET_REMEMBERED_NOTE,
  METANET_OPTION_ID, METANET_TYPE, NOT_YOU_LABEL, warnIfNoLogout,
} from './metanet.js';

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
/* "Other wallets" (0.5.6): one small link under the button */
.ow{margin:8px 0 0;width:0;min-width:100%;font-size:12px;line-height:1.4;color:#71717a;text-align:center}
:host([theme=dark]) .ow,:host-context(.dark) .ow{color:#a1a1aa}
.sw{margin:8px 0 0;width:0;min-width:100%;font-size:12px;line-height:1.4;color:#a16207;text-align:center}
:host([theme=dark]) .sw,:host-context(.dark) .sw{color:#fcd34d}
.mn{margin:8px 0 0;width:0;min-width:100%;font-size:12px;line-height:1.4;color:#71717a;text-align:center}
.mn small{display:block;font-size:11px;opacity:.85}
:host([theme=dark]) .mn,:host-context(.dark) .mn{color:#a1a1aa}
.lnk{all:unset;cursor:pointer;color:inherit;font-weight:600;text-decoration:underline;text-underline-offset:2px}
.lnk:focus-visible{outline:2px solid #b45309;outline-offset:2px;border-radius:2px}
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
/** The pending label when the user picked a wallet other than bWalletX. */
export const PENDING_LABEL_OTHER = 'Approve in your wallet…';

/**
 * What started a sign-in: the button ('signin'), "Other wallets" ('chooser'), "Switch" ('bwalletx', 0.6.0) or "Use
 * Metanet Desktop or another BRC-100 wallet" ('metanet', 0.7.0).
 */
export type SigninMode = 'signin' | 'chooser' | 'bwalletx' | 'metanet';

/** (0.6.0) The note shown when the remembered or connected wallet isn't bWalletX. */
export const SWITCH_NOTE = 'Some features need bWalletX';
/** (0.6.0) The button's label when the tap goes to a remembered wallet that isn't bWalletX. */
export const CONTINUE_OTHER_LABEL = 'Continue with your wallet';

/** A neutral wallet glyph: the button must not show bWalletX's "b" when the tap goes to another wallet. */
function walletGlyph(px: number): string {
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true" focusable="false" fill="none" stroke="#FFD24D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 6v12a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-3"/></svg>`;
}

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

const OBSERVED = ['size', 'theme', 'label', 'brand', 'subtitle', 'loading', 'disabled', 'full-width', 'aria-label', 'get-url', 'web-url', 'state', 'identity-key', 'paymail', 'handle', 'avatar-url', 'error', 'other-wallets', 'challenge-url', 'wallet-type', 'switch-note', 'remember', 'metanet'];
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
    #pendingLabel = PENDING_LABEL;
    /** The wallet type signed in with here (0.6.0), for the Switch note. */
    #signedType: string | null = null;
    #menu: { host: HTMLElement; close: (focusChip?: boolean) => void } | null = null;
    /** (0.7.0) A Metanet sign-in (tapped or silent) is in flight. */
    #viaMetanet = false;
    /** (0.7.0) Bumped by "Not you?": a Metanet sign-in started before it lands nobody. */
    #run = 0;

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      if (!this.#controlled && this.#stateful) warnIfNoLogout({ verifyUrl: this.#attr('verify-url'), logoutUrl: this.#attr('logout-url'), where: '<bwalletx-signin>' });
      this.#render();
      this.#unwake?.();
      this.#unwake = onPageWake(() => void this.#recheck());
      // 0.9.0: bWalletX sent the user back here after Connect on the same phone: finish that sign-in first.
      if (hasReturnFragment())
        void this.#resumeReturn().then((done) => (done ? undefined : this.#restore().then(() => this.#silentMetanet())));
      else void this.#restore().then(() => this.#silentMetanet());
    }
    disconnectedCallback() { this.#menu?.close(false); this.#hideTip(); this.#unwake?.(); this.#unwake = null; }

    #unwake: (() => void) | null = null;

    /**
     * (0.9.0) The page has `#bwx=ok&rid=…`: bWalletX returned here after Connect (on a phone, often in a new tab).
     * Finish the pairing saved for that rid and post the folded sign-in to verify-url. True when signed in.
     */
    async #resumeReturn(): Promise<boolean> {
      if (!hasReturnFragment()) return false;
      const r = await resumeReturnedPairing().catch(() => null);
      if (!r?.login) return false;
      const { identityKey, nonce, signature } = r.login;
      const verifyUrl = this.#attr('verify-url');
      let response: { handle?: string; paymail?: string } | null = null;
      try {
        if (verifyUrl) response = await postJson<{ handle?: string; paymail?: string }>(verifyUrl, { identityKey, nonce, signature });
      } catch (error) {
        this.#emit('bwalletx-error', { error });
        return false;
      }
      if (verifyUrl) rememberIdentity(identityKey);
      if (this.#stateful && !this.#controlled) this.#signedIn({ identityKey, handle: response?.handle ?? null, paymail: response?.paymail ?? null });
      this.#emit('bwalletx-signed-in', { identityKey, method: 'pairing', nonce, signature, response });
      // The wallet returns to this origin's root (review 22 Nov 2026); go back to the page the sign-in started on.
      if (r.page && `${location.origin}${location.pathname}` !== r.page) location.replace(r.page);
      return true;
    }

    /**
     * (0.9.0) The page is back (another tab, or the wallet, may have signed in meanwhile): re-read session-url once,
     * quietly, when signed out and nothing is in flight. No wallet call, no "restoring" flicker.
     */
    async #recheck() {
      const url = this.#attr('session-url');
      if (!url || this.#controlled || !this.#stateful || this.#busy || this.#phase === 'signed-in' || this.#phase === 'restoring') return;
      try {
        const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
        const j = (await r.json().catch(() => ({}))) as { identityKey?: string | null; handle?: string | null; paymail?: string | null };
        if (j.identityKey && !this.#busy && (this.#phase as SigninState) !== 'signed-in') this.#signedIn({ identityKey: j.identityKey, handle: j.handle ?? null, paymail: j.paymail ?? null });
      } catch {
        /* offline: try again next time */
      }
    }
    attributeChangedCallback() { if (this.isConnected) this.#render(); }

    /** The inner <button>, for focus() and tests. */
    get button(): HTMLButtonElement | null { return this.#root.querySelector('button'); }
    get notFound() { return this.#notFound; }
    /** The state shown now (the `state` attribute when set, else the element's own). */
    get state(): SigninState {
      const a = this.#attr('state') as SigninState | null;
      return a && STATES.includes(a) ? a : this.#phase;
    }
    /** React 19 sets known custom-element props as properties: mirror `state` to the attribute (0.9.1). */
    set state(v: SigninState | null | undefined) {
      if (v == null) this.removeAttribute('state');
      else this.setAttribute('state', String(v));
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
      const pendingLabel = this.#controlled ? PENDING_LABEL : this.#pendingLabel;
      // 0.6.0: the tap goes to a remembered wallet that isn't bWalletX, so the button says so (and drops the "b").
      const elsewhere = state === 'signed-out' && tapGoesElsewhere(this.#walletType());
      const text = pending ? pendingLabel : error ? 'Retry' : elsewhere ? CONTINUE_OTHER_LABEL : signinText((this.#attr('label') ?? 'signin') as SigninLabel, brand);
      const subAttr = this.#attr('subtitle');
      const subDefault = brand === 'bWalletX' && (size === 'lg' || size === 'md') ? 'also works with bWallet' : null;
      const subtitle = pending || error || elsewhere ? null : subAttr === null || subAttr === '' || subAttr === 'on' ? (subAttr === 'on' ? 'also works with bWallet' : subDefault)
        : subAttr === 'off' ? null : subAttr;
      const loading = this.hasAttribute('loading') || this.#busy || pending || restoring;
      const disabled = this.hasAttribute('disabled');
      const markPx = size === 'icon' ? 24 : size === 'sm' ? 15 : size === 'md' ? 17 : 20;
      const aria = pending ? pendingLabel : this.#attr('aria-label') ?? (subtitle && size !== 'icon' ? `${text}, ${subtitle}` : text);
      const getUrl = this.#attr('get-url') ?? GET_URL;
      const webUrl = this.#attr('web-url') ?? WEB_WALLET_URL;
      const errText = error ? (this.#controlled ? this.#attr('error') : this.#error) || 'Sign-in failed' : '';

      const label = size === 'icon' ? '' : `<span class="txt" part="text"><b part="label">${esc(text)}</b>${subtitle ? `<small part="subtitle">${esc(subtitle)}</small>` : ''}</span>`;
      const mark = loading ? '<span class="spin" aria-hidden="true"></span>' : elsewhere ? walletGlyph(markPx - 4) : markSvg(markPx);
      const otherOff = this.#attr('other-wallets') === 'off';
      const otherLink = '<button type="button" class="lnk" data-act="other" part="other-wallets-link">Other wallets</button>';
      const nf = this.#notFound
        ? `<p class="nf" part="not-found" role="status">bWalletX wasn't found in this browser. <a href="${esc(getUrl)}" target="_blank" rel="noopener">Get ${brand}</a> or <a href="${esc(webUrl)}" target="_blank" rel="noopener">use the web wallet</a>.${otherOff ? '' : ` ${otherLink}`}</p>`
        : '';
      const ow = !this.#notFound && !pending && !restoring && this.#otherWalletsShown(size) ? `<p class="ow" part="other-wallets">${otherLink}</p>` : '';
      const sw = !pending && !restoring && this.#switchNoteShown(size)
        ? `<p class="sw" part="switch-note">${esc(SWITCH_NOTE)} · <button type="button" class="lnk" data-act="switch" part="switch-link">Switch</button></p>`
        : '';
      const err = error ? `<p class="err" part="error" role="alert">${esc(errText)}</p>` : '';
      // 0.7.0: the Metanet link (its own tap only) and, when Metanet is remembered here, "Not you? Use another wallet".
      const mnHere = this.#metanetShown(size);
      const mnRemembered = mnHere && (pending ? this.#metanetPending() : !restoring && this.#walletType() === METANET_TYPE);
      const notYou = `<button type="button" class="lnk" data-act="not-you" part="not-you-link">${esc(NOT_YOU_LABEL)}</button>`;
      const mn = !mnHere
        ? ''
        : pending
          ? mnRemembered ? `<p class="mn" part="metanet">${esc(METANET_REMEMBERED_NOTE)} ${notYou}</p>` : ''
          : restoring
            ? ''
            : `<p class="mn" part="metanet"><button type="button" class="lnk" data-act="metanet" part="metanet-link" title="Connects to Metanet Desktop on this computer, never to a browser extension.">${esc(METANET_LABEL)}</button><small>${esc(METANET_NOTE)}</small>${mnRemembered ? `<small>${esc(METANET_REMEMBERED_NOTE)} ${notYou}</small>` : ''}</p>`;
      const compact = size === 'sm' || size === 'icon';
      const note = pending && !compact ? `<p class="note" part="note">${esc(PENDING_NOTE)}</p>` : '';
      const status = pending ? `<span class="sr" role="status">${esc(pendingLabel)}</span>` : loading ? '<span class="sr" role="status">Connecting to bWalletX…</span>' : '';
      this.#root.innerHTML = `<style>${SIGNIN_CSS}</style>${err}<button type="button" part="button" aria-label="${esc(aria)}" title="${esc(subtitle ? `${text} (${subtitle})` : text)}"${disabled ? ' disabled' : ''}${loading ? ' aria-busy="true"' : ''}><span class="mark" part="mark">${mark}</span>${label}</button>${status}${note}${sw}${mn}${ow}${nf}`;
      this.button!.addEventListener('click', () => void this.#click());
      for (const l of Array.from(this.#root.querySelectorAll<HTMLElement>('[data-act=other]'))) l.addEventListener('click', () => void this.otherWallets());
      this.#root.querySelector<HTMLElement>('[data-act=switch]')?.addEventListener('click', () => void this.switchToBwalletX());
      this.#root.querySelector<HTMLElement>('[data-act=metanet]')?.addEventListener('click', () => void this.useMetanet());
      this.#root.querySelector<HTMLElement>('[data-act=not-you]')?.addEventListener('click', () => this.notYou());
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
      const items = [copy, out];
      menu.append(who);
      if (needsBwalletX(this.#walletType())) {
        // 0.6.0: signed in with another wallet. One line and a way to switch.
        const sw = item('Switch to bWalletX', () => {
          close(false);
          void this.switchToBwalletX();
        });
        const line = document.createElement('div');
        line.className = 'who';
        line.textContent = SWITCH_NOTE;
        menu.append(line, sw);
        items.unshift(sw);
      }
      menu.append(copy, out);
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
      // A Disconnect means "don't connect me automatically": the remembered wallet goes too (0.6.0).
      if (this.#remember) forgetWalletChoice();
      this.#signedType = null;
      this.#account = null;
      this.#set('signed-out');
      this.#emit('bwalletx-signed-out');
      this.button?.focus();
    }

    #emit(type: string, detail?: unknown, cancelable = false) {
      return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }));
    }

    /** "Other wallets" is offered under the button: other-wallets on, or auto at lg/md when this element signs in. */
    #otherWalletsShown(size: SigninSize): boolean {
      const a = this.#attr('other-wallets');
      if (a === 'off') return false;
      if (a === 'on') return true;
      return (size === 'lg' || size === 'md') && (this.#controlled || !!this.#attr('challenge-url'));
    }

    /** Open the wallet chooser (the "Other wallets" link): phone QR, other browser wallets, desktop wallets. */
    otherWallets(): Promise<void> {
      return this.#click('chooser');
    }

    /** (0.6.0) "Switch": sign in with bWalletX (its sheet when here, else the chooser with Get bWalletX first). */
    switchToBwalletX(): Promise<void> {
      return this.#click('bwalletx');
    }

    get #remember() { return this.#attr('remember') !== 'off'; }

    /**
     * (0.7.0) "Use Metanet Desktop or another BRC-100 wallet" is offered: metanet on, or auto at lg/md when this
     * element signs in or follows a provider. Never on a phone or inside a frame.
     */
    #metanetShown(size: SigninSize): boolean {
      const a = this.#attr('metanet');
      if (a === 'off' || !metanetOffered()) return false;
      if (a === 'on') return true;
      return (size === 'lg' || size === 'md') && (this.#controlled || !!this.#attr('challenge-url'));
    }

    /** A Metanet sign-in is on screen: our own, or (driven) the provider's with Metanet remembered. */
    #metanetPending(): boolean {
      return this.#controlled ? this.#attr('wallet-type') === METANET_TYPE : this.#viaMetanet;
    }

    /** (0.7.0) The Metanet link: connect to Metanet Desktop on localhost:3321 (after this tap, never before). */
    useMetanet(): Promise<void> {
      return this.#click('metanet');
    }

    /**
     * (0.7.0) "Not you? Use another wallet": forget the remembered wallet here, and drop a Metanet sign-in in flight
     * (if its verify already set a session, logout-url ends it). Emits bwalletx-not-you (cancelable).
     */
    notYou(): void {
      if (!this.#emit('bwalletx-not-you', { element: this }, true)) return;
      this.#run++;
      if (this.#remember) forgetWalletChoice();
      this.#signedType = null;
      if (this.#viaMetanet && !this.#controlled) {
        this.#viaMetanet = false;
        this.#busy = false;
        if (this.#phase === 'pending') this.#phase = 'signed-out';
      }
      this.#render();
    }

    /**
     * (0.7.0) Rule 4: back with Metanet remembered and no session, ONE silent attempt per page load (2 s, a known
     * identity key only), then the signature alone. Any stop or failure is silent: the normal button stays.
     */
    async #silentMetanet() {
      if (this.#controlled || !this.#stateful || !this.#remember || this.#attr('require-token')) return;
      // Only where the Metanet line (and so "Not you?") is on screen: not a nav-size button, not metanet="off".
      if (!this.#metanetShown((this.#attr('size') ?? 'lg') as SigninSize)) return;
      const challengeUrl = this.#attr('challenge-url');
      const verifyUrl = this.#attr('verify-url');
      if (!challengeUrl || !verifyUrl || this.#phase !== 'signed-out' || this.#busy || silentAttemptUsed()) return;
      if (rememberedWalletChoice()?.type !== METANET_TYPE || !metanetOffered()) return;
      const run = ++this.#run;
      const live = () => run === this.#run;
      const started = Date.now();
      const r = await runSilentMetanet({
        challengeUrl,
        verifyUrl,
        post: (url, body) => postJson<Record<string, unknown>>(url, body),
        isAbandoned: () => !live(),
        logout: async () => {
          const out = this.#attr('logout-url');
          if (out) await fetch(out, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
        },
        onSignIn: () => {
          if (!live() || this.#phase !== 'signed-out' || this.#busy) return;
          this.#viaMetanet = true;
          this.#busy = true;
          this.#pendingLabel = PENDING_LABEL_OTHER;
          this.#set('pending');
        },
        onAttempt: (a) => this.#emit('bwalletx-attempt', a),
      });
      if (!live()) return;
      this.#viaMetanet = false;
      this.#busy = false;
      if (!r) {
        if ((this.#phase as SigninState) === 'pending') this.#set('signed-out');
        return;
      }
      this.#signedType = r.walletType;
      this.#signedIn({ identityKey: r.identityKey!, handle: r.handle, paymail: r.paymail });
      this.#emit('bwalletx-signed-in', { identityKey: r.identityKey, method: 'wallet', nonce: null, signature: null, response: { handle: r.handle, paymail: r.paymail }, silent: true, ms: Date.now() - started });
    }

    /** The wallet type the Switch note judges: the provider's, else what signed in here, else the remembered one. */
    #walletType(): string | null {
      if (this.#controlled) return this.#attr('wallet-type');
      return this.#signedType ?? (this.#remember ? (rememberedWalletChoice()?.type ?? null) : null);
    }

    #switchNoteShown(size: SigninSize): boolean {
      const a = this.#attr('switch-note');
      if (a === 'off' || !tapGoesElsewhere(this.#walletType())) return false;
      return a === 'on' || size === 'lg' || size === 'md';
    }

    /**
     * Signed in: note the wallet type, and remember it for this origin when the user picked it (0.6.0), plus the
     * identity key as known here (0.7.0, public keys only: Metanet's silent attempt goes on only for these). Pass a key
     * only after the site's verify route accepted it.
     */
    #picked(option: WalletOption, reason: ChoiceReason, identityKey?: string | null) {
      this.#signedType = walletTypeOf(option);
      if (this.#remember && isExplicitPick(option, reason)) rememberWalletChoice(option);
      if (this.#remember) rememberKnownIdentityKey(identityKey);
    }

    #attempt(option: WalletOption | null, outcome: AttemptOutcome, started: number) {
      this.#emit('bwalletx-attempt', attemptFor(option, outcome, started));
    }

    /**
     * Which wallet: bWalletX by its own marker goes straight to its sheet; otherwise the chooser ("Get bWalletX" first)
     * when another wallet is here or the user asked; otherwise 'not-found'. null: the chooser was closed.
     */
    async #choose(mode: SigninMode, ms: number, pairing: ReturnType<typeof pairingModal>): Promise<{ option: WalletOption; reason: ChoiceReason } | 'not-found' | null> {
      // 0.6.0: the wallet picked here before goes first when it is here (no chooser), unless this is "Switch".
      // 0.7.0: the Metanet link goes to Metanet Desktop, and only there (pinned json-api, after this tap).
      if (mode === 'metanet') return { option: metanetOption(), reason: 'requested' };
      const r = mode === 'signin' && this.#remember ? rememberedWalletChoice() : null;
      // A remembered Metanet is never the button's pick (it has its own link and the silent attempt).
      if (r && r.type !== METANET_TYPE && !(r.type === BWALLETX_TYPE && r.substrate !== 'pairing')) {
        const m = matchRemembered(await discoverWallets({ ms, pairing: () => pairing }), r);
        if (m) return { option: m, reason: 'remembered' };
      }
      if (mode !== 'chooser') {
        const f = await discoverBwalletX(ms);
        if (f) {
          const substrate = f.rdns === RDNS_EXTENSION ? 'extension' : f.rdns === RDNS_MOBILE ? 'in-app' : 'xdm';
          const option = brc100Option(f.wallet, { id: f.rdns ?? 'bwalletx-xdm', rdns: f.rdns ?? undefined, name: 'bWalletX', isBwalletX: true, substrate });
          return { option, reason: 'bwalletx' };
        }
      }
      // Already waited above: a short pass for other wallets (no localhost probe), plus bWalletX on the phone.
      const list = await discoverWallets({ ms: 50, pairing: () => pairing });
      if (mode !== 'chooser' && !hasBwalletX(list) && !otherDetected(list).length) return 'not-found';
      const picked = await chooseWallet(list, { getUrl: this.#attr('get-url') ?? undefined });
      return picked ? { option: picked, reason: 'chooser' } : null;
    }

    async #click(mode: SigninMode = 'signin') {
      if (this.hasAttribute('disabled') || this.hasAttribute('loading') || this.#busy || this.state === 'pending') return;
      if (!this.#emit('bwalletx-signin', { element: this, mode }, true)) return;

      if (mode === 'signin') {
        const href = this.#attr('href');
        const authorizeUrl = this.#attr('authorize-url');
        if (authorizeUrl) {
          location.assign(await buildAuthorizeUrl({ authorizeUrl, clientId: this.#attr('client-id'), redirectUri: this.#attr('redirect-uri'), scope: this.#attr('scope') }));
          return;
        }
        if (href) { location.assign(href); return; }
      }

      const challengeUrl = this.#attr('challenge-url');
      if (!challengeUrl) return; // event-only mode: the page runs its own flow

      const own = this.#stateful && !this.#controlled;
      const prev = this.#phase === 'signed-in' ? 'signed-in' : 'signed-out';
      const started = Date.now();
      const pairing = pairingModal();
      let option: WalletOption | null = null;
      const run = ++this.#run;
      const live = () => run === this.#run;
      this.#notFound = false;
      this.#busy = true;
      this.#viaMetanet = mode === 'metanet';
      this.#pendingLabel = mode === 'metanet' ? PENDING_LABEL_OTHER : PENDING_LABEL;
      if (own) this.#set('pending');
      else this.#render();
      try {
        const ms = Number(this.#attr('discover-ms')) || DEFAULT_DISCOVER_MS;
        const picked = await this.#choose(mode, ms, pairing);
        if (picked === 'not-found') {
          this.#notFound = true;
          if (own) this.#phase = 'signed-out';
          this.#attempt(null, 'not-found', started);
          this.#emit('bwalletx-not-found');
          if (this.#attr('require-token')) this.#emit('bwalletx-access-denied', { code: 'not_installed', message: 'No wallet found' });
          return;
        }
        if (!picked) {
          if (own) this.#phase = prev;
          this.#attempt(null, 'cancelled', started);
          return;
        }
        option = picked.option;
        const reason = picked.reason;
        if (!option.isBwalletX) {
          this.#pendingLabel = PENDING_LABEL_OTHER;
          if (own) this.#render();
        }
        // Pairing shows the QR here; "Desktop wallet" looks on localhost here (after the tap). No key asked yet.
        // 0.9.0: phone pairing gets the challenge first and folds it into Connect (one trip to bWalletX on a phone).
        const { cw, challenge: folded } = await openForSignIn(option, !this.#attr('require-token'), () =>
          postJson<Challenge>(challengeUrl, {}),
        );
        if (!live()) return; // "Not you?" while Metanet was opening
        const wallet = cw.wallet;
        if (!wallet) throw Object.assign(new Error('This wallet cannot sign in here'), { code: 'NOT_SUPPORTED' });
        const sub = substrateOf(option);
        const method = sub === 'extension' ? 'extension' : sub === 'in-app' || sub === 'xdm' ? 'in-app' : sub === 'pairing' ? 'pairing' : 'wallet';

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
              wallet,
              challenge: (identityKey) => postJson<AccessChallengeLike>(challengeUrl, { identityKey, require: hint }),
              verify: verifyUrl ? (response) => postAccess(verifyUrl, response) : undefined,
            });
            // Known only when the site's verify route checked the proof (verify-url).
            this.#picked(option, reason, verifyUrl ? a.response.identityKey : null);
            this.#attempt(option, 'signed-in', started);
            this.#emit('bwalletx-access-granted', { identityKey: a.response.identityKey, response: a.verified });
          } catch (e) {
            const err = e instanceof AccessError ? e : new AccessError('bad_request', String(e));
            this.#attempt(option, outcomeOf(e), started);
            this.#emit('bwalletx-access-denied', { code: err.code, message: err.message, have: err.have, need: err.need });
          }
          return;
        }
        // One wallet sheet: the challenge first (no key), then the key and the signature together; a repeat sign-in
        // reuses the key that signed in here last time, so it is the signature alone.
        const verifyUrl = this.#attr('verify-url');
        const { result: r, verified } = await signInAndVerify({
          wallet,
          // Metanet hands over its key on connect (one request at a time), so its sign-in is the signature alone.
          identityKey: cw.identityKey ?? undefined,
          skipWaitForAuthentication: option.id === METANET_OPTION_ID, // its connect() just checked the lock
          identityKeyHint: verifyUrl && !cw.identityKey ? rememberedIdentity() : undefined,
          challenge: (identityKey) => folded(identityKey) ?? postJson<Challenge>(challengeUrl, identityKey ? { identityKey } : {}),
          verify: async (res) => (verifyUrl ? await postJson<Record<string, unknown>>(verifyUrl, { identityKey: res.identityKey, nonce: res.nonce, signature: res.signature }) : {}),
        });
        if (!live()) {
          // "Not you?" after the wallet signed: land nobody, and end the session the verify route may have set.
          const out = this.#attr('logout-url');
          if (verifyUrl && out) await fetch(out, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
          return;
        }
        if (verifyUrl) rememberIdentity(r.identityKey);
        const response = verifyUrl ? (verified as { handle?: string; paymail?: string }) : null;
        // Known only when the site's verify route accepted the signature (verify-url); without it nothing was proved.
        this.#picked(option, reason, verifyUrl ? r.identityKey : null);
        if (own) this.#signedIn({ identityKey: r.identityKey, handle: response?.handle ?? null, paymail: response?.paymail ?? null });
        this.#attempt(option, 'signed-in', started);
        this.#emit('bwalletx-signed-in', { identityKey: r.identityKey, method, nonce: r.nonce, signature: r.signature, response });
      } catch (error) {
        // 0.9.0: bWalletX returned to a NEW tab, which finished the sign-in: this tab just picks up the session.
        if ((error as { code?: string })?.code === 'RETURNED_IN_ANOTHER_TAB') {
          if (own) this.#phase = prev;
          queueMicrotask(() => void this.#recheck());
          return;
        }
        const outcome = outcomeOf(error);
        this.#attempt(option, outcome, started);
        if (!live()) return; // dropped by "Not you?": no error to show
        // Closing the phone QR is not an error: back to where we were. Anything else shows as before.
        const closedQr = outcome === 'cancelled' && option?.kind === 'pairing';
        if (own) {
          if (closedQr) this.#phase = prev;
          else {
            this.#error = signInErrorText(error);
            this.#phase = 'error';
          }
        }
        if (!closedQr) this.#emit('bwalletx-error', { error });
      } finally {
        try { pairing.close(); } catch { /* closed */ }
        if (live()) {
          this.#busy = false;
          this.#viaMetanet = false;
          this.#render();
        }
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
