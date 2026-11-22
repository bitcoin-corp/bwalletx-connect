/**
 * Site side of b*X single sign-on, browser half: the top-right "Sign in with bWalletX" button, the account chip when
 * signed in, the `bwx:signin` event, and the top-level PKCE redirect to the hub (never an iframe: Safari blocks
 * third-party cookies, and a framed sign-in can be clickjacked).
 *
 *   import { bwxSso } from '@bwalletx/connect/sso';
 *   bwxSso({ clientId: 'bsvapi' });            // mounts into [data-bwx-sso], else a fixed top-right slot
 *   window.dispatchEvent(new Event('bwx:signin'));  // any page or gate opens sign-in (gates add ?returnTo=)
 *
 * The browser never sees a token: the code goes to your /sso/callback, which sets an httpOnly cookie.
 */
import {
  DEFAULT_CALLBACK_PATH,
  DEFAULT_HUB,
  DEFAULT_LOGOUT_PATH,
  DEFAULT_SESSION_PATH,
  GET_BWALLETX_URL,
  SIGNIN_EVENT,
  encodeTx,
  hubOrigin,
  pkceChallenge,
  randomToken,
  safeReturnTo,
  txCookieName,
  type RiskTier,
} from './shared.js';

export interface SsoSessionInfo {
  signedIn: boolean;
  identityKey?: string;
  paymail?: string | null;
  handle?: string | null;
  tier?: RiskTier;
  iat?: number;
  exp?: number;
  started?: number;
  /** When the wallet sign-in at the hub happened (seconds). */
  authTime?: number | null;
}

export interface BwxSsoOptions {
  /** Your client_id in the hub's registry. */
  clientId: string;
  /** Default https://id.bwalletx.com. */
  hub?: string;
  /** Default /sso/callback. Must be the redirect URI registered for your site (on this origin). */
  callbackPath?: string;
  /** Default /sso/session. */
  sessionPath?: string;
  /** Default /sso/logout. */
  logoutPath?: string;
  /** Where to render: an element or selector. Default [data-bwx-sso], else a fixed slot at the top right. */
  mount?: HTMLElement | string | null;
  /**
   * On a first visit with no site session, quietly ask the hub (prompt=none, a top-level redirect that comes straight
   * back) whether the visitor is already signed in to another b*X site. Once per tab; again after an hour. Default true.
   */
  silent?: boolean;
  /** Where to land after signing in when the page has no ?returnTo= (e.g. "/dashboard" on a sign-in page). Default: this page. */
  returnTo?: string;
  /** "Your page" link in the chip menu (e.g. "/dashboard"). Hidden when unset. */
  accountUrl?: string;
  accountLabel?: string;
  /** Show the "Signed in as …" toast after signing in. Default true. */
  toast?: boolean;
  /** Called whenever the signed-in state is known or changes. */
  onChange?: (s: SsoSessionInfo) => void;
}

export interface BwxSso {
  /** Top-level redirect to the hub. prompt 'login' forces a fresh wallet sign-in (sensitive pages). */
  signIn(o?: { returnTo?: string; prompt?: 'none' | 'login' }): Promise<void>;
  /** Sign out of this site, or of every b*X site (via the hub). */
  signOut(everywhere?: boolean): Promise<void>;
  refresh(): Promise<SsoSessionInfo>;
  readonly session: SsoSessionInfo;
  destroy(): void;
}

const CSS = `
.bwx-sso{position:relative;display:inline-flex;align-items:center;gap:8px;font:600 14px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:100%}
.bwx-sso-fixed{position:fixed;top:12px;right:16px;z-index:2147483000}
.bwx-sso button,.bwx-sso a{font:inherit}
.bwx-sso-btn{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:9px 16px;background:#f5b800;color:#000;cursor:pointer;white-space:nowrap;box-shadow:0 0 0 1px #f5b800}
.bwx-sso-btn:hover{background:#ffd23f}
.bwx-sso-btn:focus-visible,.bwx-sso-chip:focus-visible,.bwx-sso-item:focus-visible{outline:2px solid #ffd23f;outline-offset:2px}
.bwx-sso-btn[disabled]{opacity:.8;cursor:progress}
.bwx-sso-b{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#000;color:#f5b800;font-weight:800;font-size:13px}
.bwx-sso-get{color:#f5b800;font-size:12px;font-weight:500;text-decoration:none;white-space:nowrap;background:#000;padding:4px 8px;border-radius:999px}
.bwx-sso-get:hover{text-decoration:underline}
.bwx-sso-chip{display:inline-flex;align-items:center;gap:8px;max-width:240px;border:1px solid #f5b800;border-radius:999px;padding:4px 12px 4px 4px;background:#000;color:#f5b800;cursor:pointer}
.bwx-sso-av{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#ffe27a,#f5b800 55%,#b88600);color:#000;font-weight:800}
.bwx-sso-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bwx-sso-menu{position:absolute;top:calc(100% + 8px);right:0;min-width:230px;max-width:calc(100vw - 32px);background:#000;border:1px solid #f5b800;border-radius:14px;padding:6px;box-shadow:0 12px 32px rgba(0,0,0,.5);z-index:2147483001}
.bwx-sso-menu[hidden]{display:none}
.bwx-sso-who{padding:8px 10px;color:#f5b800;font-weight:500;font-size:12px;overflow-wrap:anywhere;border-bottom:1px solid rgba(245,184,0,.35);margin-bottom:4px}
.bwx-sso-item{display:block;width:100%;text-align:left;background:none;border:0;border-radius:10px;padding:10px;color:#f5b800;text-decoration:none;cursor:pointer;font-weight:600}
.bwx-sso-item:hover{background:#f5b800;color:#000}
.bwx-sso-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:calc(100vw - 32px);background:#000;color:#f5b800;border:1px solid #f5b800;border-radius:999px;padding:10px 18px;font:600 14px system-ui,sans-serif;z-index:2147483002;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:480px){.bwx-sso-long{display:none}.bwx-sso-get{display:none}.bwx-sso-chip{max-width:150px}}
`;

const SILENT_KEY = 'bwx_sso_silent:';
const TOAST_KEY = 'bwx_sso_toasted:';
const SILENT_RETRY_MS = 3600 * 1000;

function store(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;
const displayName = (s: SsoSessionInfo) => s.paymail || (s.handle ? s.handle : s.identityKey ? shortKey(s.identityKey) : 'Signed in');

/**
 * returnTo for a sign-in: ?returnTo= on this page (gates send visitors with it), else the default, else this page.
 * Every source goes through safeReturnTo, so a crafted ?returnTo= can only ever name a path on this site.
 */
function currentReturnTo(fallback?: string): string {
  const q = new URLSearchParams(location.search).get('returnTo');
  if (q) return safeReturnTo(q, '/');
  if (fallback) return safeReturnTo(fallback, '/');
  const u = new URL(location.href);
  u.searchParams.delete('sso_error');
  return safeReturnTo(u.pathname + u.search + u.hash, '/');
}

/** Mount the sign-in button / account chip and wire the `bwx:signin` event. */
export function bwxSso(opts: BwxSsoOptions): BwxSso {
  const hub = hubOrigin(opts.hub ?? DEFAULT_HUB);
  const callbackPath = opts.callbackPath ?? DEFAULT_CALLBACK_PATH;
  const sessionPath = opts.sessionPath ?? DEFAULT_SESSION_PATH;
  const logoutPath = opts.logoutPath ?? DEFAULT_LOGOUT_PATH;
  let session: SsoSessionInfo = { signedIn: false };
  let destroyed = false;

  if (!document.getElementById('bwx-sso-css')) {
    const st = document.createElement('style');
    st.id = 'bwx-sso-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  let host: HTMLElement | null =
    typeof opts.mount === 'string' ? document.querySelector<HTMLElement>(opts.mount) : (opts.mount ?? document.querySelector<HTMLElement>('[data-bwx-sso]'));
  let ownHost = false;
  if (!host) {
    host = el('div', 'bwx-sso-fixed');
    document.body.appendChild(host);
    ownHost = true;
  }
  const root = el('div', 'bwx-sso');
  root.setAttribute('data-bwx-sso-root', '');
  host.appendChild(root);

  async function signIn(o: { returnTo?: string; prompt?: 'none' | 'login' } = {}) {
    const state = randomToken(32);
    const verifier = randomToken(48);
    const returnTo = safeReturnTo(o.returnTo ?? currentReturnTo(opts.returnTo), '/');
    const https = location.protocol === 'https:';
    // Readable by your server at /sso/callback; single use, 10 minutes, this attempt only. On https the name is
    // __Host-… (Secure, Path=/, no Domain), so a sibling subdomain can't plant one for the callback to read.
    document.cookie = `${txCookieName(state, https)}=${encodeTx({ state, verifier, returnTo })}; Path=/; Max-Age=600; SameSite=Lax${https ? '; Secure' : ''}`;
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: opts.clientId,
      redirect_uri: location.origin + callbackPath,
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    });
    if (o.prompt) q.set('prompt', o.prompt);
    location.assign(`${hub}/authorize?${q}`);
  }

  async function signOut(everywhere = false) {
    let redirect: string | null = null;
    try {
      const r = await fetch(logoutPath + (everywhere ? '?everywhere=1' : ''), { method: 'POST', credentials: 'same-origin' });
      redirect = ((await r.json()) as { redirect?: string | null }).redirect ?? null;
    } catch {
      /* the cookie is cleared server-side; show signed out anyway */
    }
    store('session')?.setItem(SILENT_KEY + opts.clientId, String(Date.now())); // don't silently sign straight back in
    set({ signedIn: false });
    window.dispatchEvent(new CustomEvent('bwx:signedout', { detail: { everywhere } }));
    if (everywhere) location.assign(redirect ?? `${hub}/logout`);
  }

  function showToast(text: string) {
    const t = el('div', 'bwx-sso-toast', text);
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function render() {
    root.replaceChildren();
    if (!session.signedIn) {
      const btn = el('button', 'bwx-sso-btn');
      btn.type = 'button';
      btn.setAttribute('data-bwx-sso-signin', '');
      btn.append(el('span', 'bwx-sso-b', 'b'), el('span', '', 'Sign in'), el('span', 'bwx-sso-long', ' with bWalletX'));
      btn.onclick = () => {
        btn.disabled = true;
        btn.lastChild!.textContent = '…';
        void signIn();
      };
      const get = el('a', 'bwx-sso-get', 'Get bWalletX');
      get.href = GET_BWALLETX_URL;
      get.target = '_blank';
      get.rel = 'noopener';
      root.append(btn, get);
      return;
    }
    const name = displayName(session);
    const chip = el('button', 'bwx-sso-chip');
    chip.type = 'button';
    chip.setAttribute('data-bwx-sso-chip', '');
    chip.setAttribute('aria-haspopup', 'menu');
    chip.setAttribute('aria-expanded', 'false');
    const named = session.paymail || session.handle;
    const initial = named ? named.replace(/^\$/, '').charAt(0).toUpperCase() || 'b' : 'b';
    chip.append(el('span', 'bwx-sso-av', initial), el('span', 'bwx-sso-name', name));
    const menu = el('div', 'bwx-sso-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.append(el('div', 'bwx-sso-who', `Signed in as ${name}`));
    if (opts.accountUrl) {
      const a = el('a', 'bwx-sso-item', opts.accountLabel ?? 'Your page');
      a.href = opts.accountUrl;
      a.setAttribute('role', 'menuitem');
      menu.append(a);
    }
    const one = el('button', 'bwx-sso-item', 'Sign out of this site');
    one.type = 'button';
    one.setAttribute('role', 'menuitem');
    one.onclick = () => void signOut(false);
    const all = el('button', 'bwx-sso-item', 'Sign out of all b*X sites');
    all.type = 'button';
    all.setAttribute('role', 'menuitem');
    all.onclick = () => void signOut(true);
    menu.append(one, all);
    const close = (e: Event) => {
      if (!root.contains(e.target as Node)) {
        menu.hidden = true;
        chip.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', close);
      }
    };
    chip.onclick = () => {
      menu.hidden = !menu.hidden;
      chip.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) setTimeout(() => document.addEventListener('click', close), 0);
    };
    root.append(chip, menu);
  }

  function set(s: SsoSessionInfo) {
    session = s;
    if (destroyed) return;
    render();
    try {
      opts.onChange?.(s);
    } catch {
      /* UI callback */
    }
  }

  async function refresh(): Promise<SsoSessionInfo> {
    try {
      const r = await fetch(sessionPath, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      set(r.ok ? ((await r.json()) as SsoSessionInfo) : { signedIn: false });
    } catch {
      set({ signedIn: false });
    }
    return session;
  }

  const onSignInEvent = (e: Event) => {
    const d = (e as CustomEvent<{ returnTo?: string; prompt?: 'login' }> | undefined)?.detail;
    void signIn({ returnTo: d?.returnTo, prompt: d?.prompt });
  };
  window.addEventListener(SIGNIN_EVENT, onSignInEvent);

  render();
  void refresh().then((s) => {
    if (destroyed) return;
    const ss = store('session');
    if (s.signedIn) {
      // "Signed in as …" once per sign-in.
      const mark = `${s.identityKey}:${s.started ?? s.iat}`;
      if (opts.toast !== false && s.started && Date.now() / 1000 - s.started < 60 && ss?.getItem(TOAST_KEY + opts.clientId) !== mark) {
        ss?.setItem(TOAST_KEY + opts.clientId, mark);
        showToast(`Signed in as ${displayName(s)}`);
      }
      window.dispatchEvent(new CustomEvent('bwx:signedin', { detail: s }));
      return;
    }
    if (opts.silent === false || new URLSearchParams(location.search).has('sso_error')) return;
    const last = Number(ss?.getItem(SILENT_KEY + opts.clientId) ?? 0);
    if (!ss || Date.now() - last < SILENT_RETRY_MS) return;
    ss.setItem(SILENT_KEY + opts.clientId, String(Date.now()));
    void signIn({ prompt: 'none' });
  });

  return {
    signIn,
    signOut,
    refresh,
    get session() {
      return session;
    },
    destroy() {
      destroyed = true;
      window.removeEventListener(SIGNIN_EVENT, onSignInEvent);
      root.remove();
      if (ownHost) host?.remove();
    },
  };
}

export { SIGNIN_EVENT, DEFAULT_HUB, GET_BWALLETX_URL };
