// @vitest-environment happy-dom
/**
 * 0.5.5: the one official element is stateful. signed out → pending → signed in (badge + menu) → disconnect; reload
 * restores from session-url with no wallet call; errors show one line + Retry ("Sign-in cancelled" for a no).
 */
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineBwalletxSignin, PENDING_LABEL, PENDING_NOTE } from '../src/element';
import { accountFor, signinStateFor, type BwalletXContextValue } from '../src/react';
import { accountLabel, avatarUrlFor, signInErrorText } from '../src/account';
import { createChallenge, memoryStore, verifySignIn } from '../src/server';

type El = HTMLElement & { button: HTMLButtonElement; state: string; account: { identityKey: string; paymail?: string | null } | null; menuOpen: boolean; signOut(): Promise<void> };

const ORIGIN = 'https://example.com';
const store = memoryStore({ quiet: true });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(5);
  }
};

function mount(attrs: Record<string, string> = {}, parent: HTMLElement = document.body): El {
  const el = document.createElement('bwalletx-signin') as El;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent.appendChild(el);
  return el;
}
const q = (el: El, sel: string) => el.shadowRoot!.querySelector<HTMLElement>(sel);
const menuHost = () => document.querySelector<HTMLElement>('[data-bwalletx-menu]');
const menuItems = (): HTMLButtonElement[] => Array.from(menuHost()?.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? []);

/** Announce a ProtoWallet as the bWalletX extension; count its wallet calls. */
function extension(o: { deny?: boolean } = {}) {
  const root = PrivateKey.fromRandom();
  const pw = new ProtoWallet(root);
  const calls: string[] = [];
  let deny = !!o.deny;
  const wallet = {
    isAuthenticated: async () => ({ authenticated: true }),
    waitForAuthentication: async () => (calls.push('waitForAuthentication'), { authenticated: true }),
    getPublicKey: async (a: Parameters<ProtoWallet['getPublicKey']>[0]) => (calls.push('getPublicKey'), pw.getPublicKey(a)),
    createSignature: async (a: Parameters<ProtoWallet['createSignature']>[0]) => {
      calls.push('createSignature');
      await tick(20); // the sheet is up
      if (deny) throw Object.assign(new Error('The user denied the request.'), { code: 'ERR_PERMISSION_DENIED' });
      return pw.createSignature(a);
    },
  } as unknown as WalletInterface;
  const announce = () => window.dispatchEvent(Object.assign(new Event('brc100:announceWallet'), { detail: { info: { rdns: 'com.bwalletx.extension' }, wallet } }));
  window.addEventListener('brc100:requestWallet', announce);
  return {
    key: root.toPublicKey().toString(),
    calls,
    allow: () => (deny = false),
    stop: () => window.removeEventListener('brc100:requestWallet', announce),
  };
}

/** The site's routes, backed by the real server helpers. */
function routes(o: { paymail?: string; session?: { identityKey: string | null; paymail?: string } } = {}) {
  const hits: string[] = [];
  let session = o.session ?? { identityKey: null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      hits.push(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/c') return json(await createChallenge({ origin: ORIGIN, identityKey: body.identityKey, store }));
      if (url === '/v') {
        const k = await verifySignIn({ origin: ORIGIN, store, ...body });
        if (!k) return json({ error: 'sign-in failed' }, 401);
        session = { identityKey: k };
        return json({ identityKey: k });
      }
      if (url === '/s') return json(session);
      if (url === '/out') {
        session = { identityKey: null };
        return json({ ok: true });
      }
      if (url.startsWith('https://pay.bwallet.space/')) return o.paymail ? json({ paymail: o.paymail }) : json({ error: 'not-found' }, 404);
      return json({}, 404);
    }),
  );
  return { hits };
}

beforeAll(() => {
  defineBwalletxSignin();
});
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<bwalletx-signin> states (standalone)', () => {
  it('signed out → pending (label + one plain line) → signed in badge', async () => {
    const ext = extension();
    routes({ paymail: 'alice@bwalletx.com' });
    const el = mount({ 'challenge-url': '/c', 'verify-url': '/v', 'discover-ms': '50' });
    expect(el.state).toBe('signed-out');
    expect(q(el, 'b')!.textContent).toBe('Sign in with bWalletX');
    el.button.click();
    await until(() => el.state === 'pending');
    expect(q(el, 'b')!.textContent).toBe(PENDING_LABEL);
    expect(q(el, '.note')!.textContent).toBe(PENDING_NOTE);
    expect(el.button.getAttribute('aria-busy')).toBe('true');
    await until(() => el.state === 'signed-in');
    expect(el.account?.identityKey).toBe(ext.key);
    expect(q(el, '.chip')).not.toBeNull();
    expect(q(el, '.dot')).not.toBeNull();
    expect(q(el, '.av img')!.getAttribute('src')).toBe(avatarUrlFor(ext.key));
    await until(() => q(el, '.name')!.textContent === '$alice'); // paymail lookup, best effort
    expect(el.button.getAttribute('aria-haspopup')).toBe('menu');
    ext.stop();
  });

  it('shows a short key when there is no paymail', async () => {
    const ext = extension();
    routes();
    const el = mount({ 'challenge-url': '/c', 'verify-url': '/v', 'discover-ms': '50' });
    el.button.click();
    await until(() => el.state === 'signed-in');
    await tick(20);
    expect(q(el, '.name')!.textContent).toBe(`${ext.key.slice(0, 6)}…${ext.key.slice(-4)}`);
    ext.stop();
  });

  it('a pending sm button puts the line in a body-level tip, not in the header', async () => {
    const ext = extension();
    routes();
    const el = mount({ size: 'sm', 'challenge-url': '/c', 'verify-url': '/v', 'discover-ms': '50' });
    el.button.click();
    await until(() => el.state === 'pending');
    expect(q(el, '.note')).toBeNull();
    const tip = document.querySelector('[data-bwalletx-tip]')?.shadowRoot?.querySelector('.tip');
    expect(tip?.textContent).toBe(PENDING_NOTE);
    await until(() => el.state === 'signed-in');
    expect(document.querySelector('[data-bwalletx-tip]')).toBeNull();
    ext.stop();
  });

  it('a no in the wallet → "Sign-in cancelled" + Retry; Retry signs in', async () => {
    const ext = extension({ deny: true });
    routes();
    const errors: unknown[] = [];
    const el = mount({ 'challenge-url': '/c', 'verify-url': '/v', 'discover-ms': '50' });
    el.addEventListener('bwalletx-error', (e) => errors.push((e as CustomEvent).detail.error));
    el.button.click();
    await until(() => el.state === 'error');
    expect(q(el, '.err')!.textContent).toBe('Sign-in cancelled');
    expect(q(el, '.err')!.getAttribute('role')).toBe('alert');
    expect(q(el, 'b')!.textContent).toBe('Retry');
    expect(errors).toHaveLength(1);
    ext.allow();
    el.button.click();
    await until(() => el.state === 'signed-in');
    ext.stop();
  });

  it('reload restores the badge from session-url with no wallet call', async () => {
    const ext = extension();
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const { hits } = routes({ session: { identityKey: key, paymail: 'bob@bwalletx.com' } });
    const el = mount({ 'session-url': '/s', 'challenge-url': '/c', 'verify-url': '/v' });
    expect(el.state).toBe('restoring');
    await until(() => el.state === 'signed-in');
    expect(q(el, '.name')!.textContent).toBe('$bob');
    expect(ext.calls).toEqual([]);
    expect(hits).toEqual(['/s']);
    ext.stop();
  });

  it('no session → signed out after restoring', async () => {
    routes();
    const el = mount({ 'session-url': '/s', 'challenge-url': '/c' });
    await until(() => el.state === 'signed-out');
  });

  it('Disconnect from the menu posts logout-url and returns to signed out', async () => {
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const { hits } = routes({ session: { identityKey: key } });
    const el = mount({ 'session-url': '/s', 'logout-url': '/out', 'lookup-url': 'off' });
    await until(() => el.state === 'signed-in');
    const out = new Promise((r) => el.addEventListener('bwalletx-signed-out', r));
    el.button.click();
    expect(el.menuOpen).toBe(true);
    menuItems().find((b) => b.textContent === 'Disconnect')!.click();
    await out;
    expect(el.state).toBe('signed-out');
    expect(hits).toContain('/out');
    expect(menuHost()).toBeNull();
  });
});

describe('badge menu', () => {
  const signedIn = async (attrs: Record<string, string> = {}, parent?: HTMLElement) => {
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    routes({ session: { identityKey: key, ...(attrs.paymail ? { paymail: attrs.paymail } : {}) } });
    const el = mount({ 'session-url': '/s', 'lookup-url': 'off' }, parent);
    await until(() => el.state === 'signed-in');
    return { el, key };
  };

  it('is a body-level fixed portal, so an overflow:hidden header cannot clip it', async () => {
    const header = document.createElement('header');
    header.style.overflow = 'hidden';
    header.style.height = '40px';
    document.body.appendChild(header);
    const { el } = await signedIn({}, header);
    el.button.click();
    const host = menuHost()!;
    expect(host.parentElement).toBe(document.body);
    expect(header.contains(host)).toBe(false);
    const menu = host.shadowRoot!.querySelector<HTMLElement>('.menu')!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect(getComputedStyle(menu).position).toBe('fixed');
    expect(parseFloat(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 32);
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(16);
  });

  it('fits a phone: no wider than the screen minus the gutters', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 280 });
    const { el } = await signedIn();
    el.button.click();
    const menu = menuHost()!.shadowRoot!.querySelector<HTMLElement>('.menu')!;
    expect(parseFloat(menu.style.width)).toBe(248);
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(280 - 16);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('keyboard: Enter opens and focuses the first item, arrows move, Escape closes back to the badge', async () => {
    const { el } = await signedIn();
    el.button.focus();
    el.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el.menuOpen).toBe(true);
    expect(el.button.getAttribute('aria-expanded')).toBe('true');
    const root = menuHost()!.shadowRoot!;
    expect(root.activeElement?.textContent).toBe('Copy key');
    const menu = root.querySelector('.menu')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(root.activeElement?.textContent).toBe('Disconnect');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(root.activeElement?.textContent).toBe('Copy key');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.menuOpen).toBe(false);
    expect(el.button.getAttribute('aria-expanded')).toBe('false');
  });

  it('copies the paymail when there is one, else the key', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { el } = await signedIn({ paymail: 'carol@bwalletx.com' });
    el.button.click();
    const copy = menuItems()[0]!;
    expect(copy.textContent).toBe('Copy paymail');
    copy.click();
    await tick(10);
    expect(writeText).toHaveBeenCalledWith('carol@bwalletx.com');
  });
});

describe('controlled by the provider (state attribute)', () => {
  it('renders each state from attributes and never changes its own state', async () => {
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const el = mount({ state: 'pending' });
    expect(q(el, '.note')!.textContent).toBe(PENDING_NOTE);
    el.setAttribute('state', 'error');
    el.setAttribute('error', 'Sign-in cancelled');
    expect(q(el, '.err')!.textContent).toBe('Sign-in cancelled');
    el.setAttribute('state', 'signed-in');
    el.setAttribute('identity-key', key);
    el.setAttribute('paymail', 'dave@bwalletx.com');
    expect(q(el, '.name')!.textContent).toBe('$dave');
    // Disconnect is an event the provider answers (preventDefault + its own disconnect()).
    const seen: Event[] = [];
    el.addEventListener('bwalletx-disconnect', (e) => {
      seen.push(e);
      e.preventDefault();
    });
    el.button.click();
    menuItems().find((b) => b.textContent === 'Disconnect')!.click();
    await tick(5);
    expect(seen).toHaveLength(1);
    expect(el.state).toBe('signed-in'); // still the attribute's state until the provider changes it
    el.setAttribute('state', 'signed-out');
    expect(q(el, 'b')!.textContent).toBe('Sign in with bWalletX');
  });

  it('a click in a controlled element is only an event (the provider connects)', async () => {
    const ext = extension();
    const el = mount({ state: 'signed-out', 'challenge-url': '/c' });
    el.addEventListener('bwalletx-signin', (e) => e.preventDefault());
    el.button.click();
    await tick(30);
    expect(ext.calls).toEqual([]);
    ext.stop();
  });
});

describe('provider state → element state and useBwalletXAccount', () => {
  const base = { identityKey: null, handle: null, paymail: null, wallet: null, walletId: null, transitional: false, signedIn: false, error: null };
  const ctx = (o: Partial<BwalletXContextValue>) =>
    ({ ...base, status: 'idle', wallets: [], connect: async () => null, disconnect: async () => undefined, listWallets: async () => [], ...o }) as unknown as BwalletXContextValue;
  const key = PrivateKey.fromRandom().toPublicKey().toString();

  it('maps every provider status', () => {
    expect(signinStateFor(ctx({ status: 'idle' }))).toBe('signed-out');
    expect(signinStateFor(ctx({ status: 'restoring' }))).toBe('restoring');
    expect(signinStateFor(ctx({ status: 'connecting' }))).toBe('pending');
    expect(signinStateFor(ctx({ status: 'error' }))).toBe('error');
    expect(signinStateFor(ctx({ status: 'connected', identityKey: key }))).toBe('signed-in');
  });

  it('accountFor gives { status, identityKey, paymail, handle, avatarUrl, logout }', async () => {
    let out = 0;
    const a = accountFor(ctx({ status: 'connected', identityKey: key, paymail: 'erin@bwalletx.com', signedIn: true, disconnect: async () => void out++ }));
    expect(a.status).toBe('signed-in');
    expect(a.identityKey).toBe(key);
    expect(a.label).toBe('$erin');
    expect(a.avatarUrl).toBe(avatarUrlFor(key));
    await a.logout();
    expect(out).toBe(1);
    const e = accountFor(ctx({ status: 'error', error: Object.assign(new Error('User denied'), { code: 'ERR_PERMISSION_DENIED' }) }));
    expect(e.status).toBe('error');
    expect(e.error).toBe('Sign-in cancelled');
    expect(e.identityKey).toBeNull();
  });

  it('labels and error text', () => {
    expect(accountLabel({ identityKey: key, paymail: 'x@bwalletx.com' })).toBe('$x');
    expect(accountLabel({ identityKey: key, paymail: 'y@handcash.io' })).toBe('y@handcash.io');
    expect(accountLabel({ identityKey: key })).toBe(`${key.slice(0, 6)}…${key.slice(-4)}`);
    expect(signInErrorText(new Error('Permission denied.'))).toBe('Sign-in cancelled');
    expect(signInErrorText(new Error('boom'))).toBe('Sign-in failed');
  });
});
