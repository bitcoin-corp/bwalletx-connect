// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ShellBridge, SLOT_IDS, _resetWalletState, applyManifest, defineBappShell, detectWalletUA, isSameOriginPath,
  parseManifest, validateManifest, walletState, type BappManifest,
} from '../src/shell/index';

const sample = JSON.parse(readFileSync(resolve(__dirname, '../examples/bapp.bmovies.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(sample));
const WALLET = 'https://web.bwalletx.com';

beforeAll(() => defineBappShell());
afterEach(() => { document.body.innerHTML = ''; document.documentElement.removeAttribute('data-bwx-in-wallet'); _resetWalletState(); vi.restoreAllMocks(); });

describe('manifest', () => {
  it('accepts the bMovies sample and applies defaults', () => {
    const r = validateManifest(sample);
    expect(r.ok).toBe(true);
    const m = r.manifest!;
    expect(m.name).toBe('bMovies');
    expect(Object.keys(m.slots)).toEqual([...SLOT_IDS]);
    expect(m.drawer).toHaveLength(6);
    expect(m.like).toEqual({ fields: sample.like.fields, amountCents: 1, currency: 'PNEE', dailyCapCents: 100 });
    const min = validateManifest({ version: 1, name: 'X', icon: '/i.png', slots: { wallet: { enabled: false }, exchange: { enabled: false }, b: { enabled: true }, feed: { path: '/f', enabled: true }, chat: { enabled: false } } });
    expect(min.ok && min.manifest.home).toBe('/');
    const like = validateManifest({ ...clone(), like: { fields: { id: 'id', token: 't' } } });
    expect(like.ok && like.manifest.like).toEqual({ fields: { id: 'id', token: 't' }, amountCents: 1, currency: 'PNEE', dailyCapCents: 100 });
  });

  it.each([
    ['https://evil.com/feed'], ['//evil.com/feed'], ['/\\evil.com'], ['javascript:alert(1)'], ['feed'], ['/a b'], [''], ['data:text/html,x'],
  ])('rejects non-same-origin path %j', (p) => {
    expect(isSameOriginPath(p)).toBe(false);
    const m = clone(); m.slots.feed.path = p;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/slots\.feed\.path/);
  });

  it('rejects absolute URLs in icon, home and drawer', () => {
    const m = clone(); m.icon = 'https://cdn.x/icon.png'; m.home = 'http://x/'; m.drawer[0].path = 'https://x/studio';
    const r = validateManifest(m);
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^icon/), expect.stringMatching(/^home/), expect.stringMatching(/^drawer\[0\]\.path/)]));
  });

  it('requires all five slots, enabled flags and paths for enabled slots', () => {
    const m = clone(); delete m.slots.chat; m.slots.feed = { enabled: true }; m.slots.wallet.enabled = 'yes'; m.slots.extra = { enabled: true };
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/slots\.chat is required/), expect.stringMatching(/slots\.feed\.path is required/),
      expect.stringMatching(/slots\.wallet\.enabled/), expect.stringMatching(/unknown slot "extra"/),
    ]));
    const b = clone(); delete b.slots.b.path;
    expect(validateManifest(b).ok).toBe(true); // b (the agent) needs no path
  });

  it('enforces like caps, version, unknown fields and theme', () => {
    const bad = (patch: (m: any) => void) => { const m = clone(); patch(m); return validateManifest(m); };
    expect(bad((m) => { m.like.dailyCapCents = 500; }).errors.join()).toMatch(/\$1 max/);
    expect(bad((m) => { m.like.amountCents = 0; }).ok).toBe(false);
    expect(bad((m) => { m.like.amountCents = 50; m.like.dailyCapCents = 10; }).errors.join()).toMatch(/exceed/);
    expect(bad((m) => { m.like.currency = 'USD'; }).ok).toBe(false);
    expect(bad((m) => { delete m.like.fields.token; }).ok).toBe(false);
    expect(bad((m) => { m.version = 2; }).ok).toBe(false);
    expect(bad((m) => { m.script = '/x.js'; }).errors.join()).toMatch(/unknown field "script"/);
    expect(bad((m) => { m.theme = { accent: 'red' }; }).ok).toBe(false);
    expect(bad((m) => { m.theme = { accent: '#00FF00' }; }).ok).toBe(true);
    expect(validateManifest(null).ok).toBe(false);
    expect(() => parseManifest({})).toThrow(/Invalid bapp.json/);
  });

  it('JSON Schema ships and agrees on the slot list', () => {
    const schema = JSON.parse(readFileSync(resolve(__dirname, '../schema/bapp.schema.json'), 'utf8'));
    expect(schema.properties.slots.required).toEqual([...SLOT_IDS]);
    const re = new RegExp(schema.$defs.path.pattern);
    expect(re.test('/feed?x=1')).toBe(true);
    for (const p of ['https://x', '//x', '/\\x', 'x']) expect(re.test(p)).toBe(false);
  });
});

type Bar = HTMLElement & { manifest: BappManifest | null; active: string | null };
const manifest = () => parseManifest(sample);
function mountBar(m = manifest(), attrs: Record<string, string> = {}): Bar {
  const el = document.createElement('bwalletx-bar') as Bar;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.setAttribute('navigate', 'manual');
  document.body.appendChild(el);
  el.manifest = m;
  return el;
}
const slotBtn = (el: Bar, id: string) => el.shadowRoot!.querySelector<HTMLButtonElement>(`button[data-slot="${id}"]`)!;

describe('<bwalletx-bar>', () => {
  it('renders five slots in order with labels and the (b) disc', () => {
    const el = mountBar();
    const ids = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>('button[data-slot]')).map((b) => b.dataset.slot);
    expect(ids).toEqual(['wallet', 'exchange', 'b', 'feed', 'chat']);
    expect(el.shadowRoot!.textContent).toMatch(/Wallet.*Exchange.*b.*Feed.*Chat/s);
    expect(el.shadowRoot!.querySelector('.b')).not.toBeNull();
    const css = el.shadowRoot!.querySelector('style')!.textContent!;
    for (const v of ['height:88px', '#0A0B0D', '#1C1C1E', 'width:20px', '#F2F2F0', '#98A2B3', 'width:52px', 'border:2px solid var(--bwx-accent)', 'opacity:.35'])
      expect(css).toContain(v);
  });

  it('disabled slots are greyed, still shown, and not clickable', () => {
    const m = manifest(); m.slots.exchange = { enabled: false }; m.slots.b = { enabled: false };
    const el = mountBar(m);
    const nav = vi.fn(); el.addEventListener('bapp-navigate', nav);
    const ex = slotBtn(el, 'exchange');
    expect(ex).toBeTruthy();
    expect(ex.disabled).toBe(true);
    expect(ex.getAttribute('aria-disabled')).toBe('true');
    ex.click(); slotBtn(el, 'b').click();
    expect(nav).not.toHaveBeenCalled();
    expect(el.active).toBeNull();
  });

  it('uses custom labels', () => {
    const m = manifest(); m.slots.exchange.label = 'Market';
    expect(mountBar(m).shadowRoot!.textContent).toContain('Market');
  });

  it('click fires bapp-navigate {slot,path} and sets the active slot', () => {
    const el = mountBar();
    const nav = vi.fn(); el.addEventListener('bapp-navigate', (e) => nav((e as CustomEvent).detail));
    const act = vi.fn(); window.addEventListener('bapp-active', act);
    slotBtn(el, 'feed').click();
    expect(nav).toHaveBeenCalledWith({ slot: 'feed', path: '/feed', source: 'web' });
    expect(el.active).toBe('feed');
    expect(slotBtn(el, 'feed').getAttribute('aria-current')).toBe('page');
    expect(slotBtn(el, 'chat').hasAttribute('aria-current')).toBe(false);
    expect(act).toHaveBeenCalled();
    window.removeEventListener('bapp-active', act);
  });

  it('navigates with location.assign unless prevented', () => {
    const el = mountBar(); el.removeAttribute('navigate');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    slotBtn(el, 'chat').click();
    expect(assign).toHaveBeenCalledWith('/chat');
    el.addEventListener('bapp-navigate', (e) => e.preventDefault());
    slotBtn(el, 'wallet').click();
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('(b) tap fires bapp-b-press; hold fires bapp-b-hold start/end and no press', async () => {
    const el = mountBar();
    const press = vi.fn(); const hold = vi.fn();
    el.addEventListener('bapp-b-press', press); el.addEventListener('bapp-b-hold', (e) => hold((e as CustomEvent).detail.phase));
    const b = slotBtn(el, 'b');
    b.click();
    expect(press).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    b.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(500);
    b.dispatchEvent(new Event('pointerup'));
    b.click();
    vi.useRealTimers();
    expect(hold.mock.calls.map((c) => c[0])).toEqual(['start', 'end']);
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('hides itself in the wallet (UA or forced)', () => {
    expect(mountBar(manifest(), { 'in-wallet': 'true' }).hasAttribute('data-in-wallet')).toBe(true);
    expect(mountBar(manifest(), { 'in-wallet': 'false' }).hasAttribute('data-in-wallet')).toBe(false);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 bWallet/5.1.2 bWalletInset/88');
    expect(mountBar().hasAttribute('data-in-wallet')).toBe(true);
  });
});

describe('<bwalletx-topbar> and <bwalletx-drawer>', () => {
  it('web: app icon + title, no ☰ or ✕; app icon opens the drawer with Home + sections', () => {
    document.body.innerHTML = '<bwalletx-topbar in-wallet="false"></bwalletx-topbar><bwalletx-drawer in-wallet="false" navigate="manual" current="/home"></bwalletx-drawer>';
    applyManifest(manifest());
    const top = document.querySelector('bwalletx-topbar')!;
    const drawer = document.querySelector('bwalletx-drawer') as HTMLElement & { open: boolean };
    expect(top.shadowRoot!.querySelector('[data-act="menu"]')).toBeNull();
    expect(top.shadowRoot!.querySelector('[data-act="close"]')).toBeNull();
    expect(top.shadowRoot!.textContent).toContain('bMovies');
    top.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="drawer"]')!.click();
    expect(drawer.open).toBe(true);
    const links = Array.from(drawer.shadowRoot!.querySelectorAll('a')).map((a) => a.textContent);
    expect(links).toEqual(['Home', 'Studio · Make', 'Timeline', 'Channels', 'Commission', 'Profile', 'Settings']);
    expect(drawer.shadowRoot!.querySelector('a[aria-current="page"]')!.textContent).toBe('Home');
    const nav = vi.fn(); drawer.addEventListener('bapp-navigate', (e) => nav((e as CustomEvent).detail));
    drawer.shadowRoot!.querySelectorAll<HTMLAnchorElement>('a')[2]!.click();
    expect(nav).toHaveBeenCalledWith({ path: '/timeline', source: 'web' });
    expect(drawer.open).toBe(false);
  });

  it('in wallet: ☰ first, then app icon, ✕ on the right; drawer offers Back to bWalletX', () => {
    document.body.innerHTML = '<bwalletx-topbar in-wallet="true"></bwalletx-topbar><bwalletx-drawer in-wallet="true" open></bwalletx-drawer>';
    applyManifest(manifest());
    const top = document.querySelector('bwalletx-topbar')!;
    const btns = Array.from(top.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.dataset.act);
    expect(btns).toEqual(['menu', 'drawer', 'close']);
    const menu = vi.fn(); const close = vi.fn();
    window.addEventListener('bapp-menu', menu); window.addEventListener('bapp-close', close);
    top.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="menu"]')!.click();
    top.shadowRoot!.querySelector<HTMLButtonElement>('[data-act="close"]')!.click();
    document.querySelector('bwalletx-drawer')!.shadowRoot!.querySelector<HTMLAnchorElement>('[data-act="close"]')!.click();
    expect(menu).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
    window.removeEventListener('bapp-menu', menu); window.removeEventListener('bapp-close', close);
  });
});

describe('in-wallet detection', () => {
  it.each([
    ['Mozilla/5.0 (iPhone) bWallet/5.1.2', true, undefined],
    ['Mozilla/5.0 (Linux; Android) YoursWalletMobile/4.0', true, undefined],
    ['Mozilla/5.0 bWalletInset/48', true, 48],
    ['Mozilla/5.0 (Macintosh) Chrome/140 Safari/537', false, undefined],
    ['Mozilla/5.0 NotbWallet', false, undefined],
  ])('%s', (ua, inWallet, inset) => {
    const d = detectWalletUA(ua);
    expect(d.inWallet).toBe(inWallet);
    expect(d.inset).toBe(inset);
  });
});

describe('ShellBridge postMessage', () => {
  let parentWin: { postMessage: ReturnType<typeof vi.fn> };
  let bridge: ShellBridge;
  beforeEach(() => {
    parentWin = { postMessage: vi.fn() };
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parentWin as unknown as Window);
    bridge = new ShellBridge({ manifest: manifest(), userAgent: 'Mozilla/5.0 Chrome' }).start();
  });
  afterEach(() => bridge.stop());
  const send = (data: unknown, origin = WALLET, source: unknown = parentWin) =>
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));

  it('ignores messages from untrusted origins or sources', () => {
    const nav = vi.fn(); window.addEventListener('bapp-navigate', nav);
    send({ type: 'bapp:hello' }, 'https://evil.example');
    send({ type: 'bapp:hello' }, WALLET, window);           // wrong source
    send({ type: 'bapp:hello' }, WALLET, { postMessage() {} }); // some other window
    send({ type: 'bapp:navigate', slot: 'feed' }, 'https://evil.example');
    expect(bridge.inWallet).toBe(false);
    expect(parentWin.postMessage).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
    window.removeEventListener('bapp-navigate', nav);
  });

  it('hello from the wallet parent → in-wallet, replies bapp:ready to that exact origin', () => {
    const seen = vi.fn(); window.addEventListener('bapp-wallet', seen);
    send({ type: 'bapp:hello', v: 1 });
    expect(bridge.inWallet).toBe(true);
    expect(walletState()).toEqual({ inWallet: true, via: 'frame' });
    expect(document.documentElement.getAttribute('data-bwx-in-wallet')).toBe('frame');
    expect(seen).toHaveBeenCalled();
    expect(parentWin.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bapp:ready' }), WALLET);
    window.removeEventListener('bapp-wallet', seen);
  });

  it('navigate: only manifest slots, never URLs; reports bapp:active', () => {
    send({ type: 'bapp:hello' });
    const nav = vi.fn(); window.addEventListener('bapp-navigate', (e) => { e.preventDefault(); nav((e as CustomEvent).detail); });
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    send({ type: 'bapp:navigate', slot: 'chat' });
    expect(nav).toHaveBeenCalledWith({ slot: 'chat', path: '/chat', source: 'wallet' });
    expect(parentWin.postMessage).toHaveBeenLastCalledWith({ type: 'bapp:active', v: 1, slot: 'chat' }, WALLET);
    nav.mockClear();
    send({ type: 'bapp:navigate', slot: 'https://evil.example/' });
    send({ type: 'bapp:navigate', slot: 'feed', path: 'https://evil.example/' } as unknown);
    send({ type: 'bapp:navigate', url: 'https://evil.example/' });
    expect(nav.mock.calls).toEqual([[{ slot: 'feed', path: '/feed', source: 'wallet' }]]); // path from the message ignored
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigate to a disabled slot is ignored', () => {
    bridge.stop();
    const m = manifest(); m.slots.exchange = { enabled: false };
    bridge = new ShellBridge({ manifest: m, userAgent: 'x' }).start();
    send({ type: 'bapp:hello' });
    const nav = vi.fn(); window.addEventListener('bapp-navigate', nav);
    send({ type: 'bapp:navigate', slot: 'exchange' });
    expect(nav).not.toHaveBeenCalled();
    window.removeEventListener('bapp-navigate', nav);
  });

  it('a custom origin allowlist replaces the default', () => {
    bridge.stop();
    bridge = new ShellBridge({ manifest: manifest(), userAgent: 'x', walletOrigins: ['chrome-extension://abc'] }).start();
    send({ type: 'bapp:hello' });
    expect(bridge.inWallet).toBe(false);
    send({ type: 'bapp:hello' }, 'chrome-extension://abc');
    expect(bridge.inWallet).toBe(true);
  });

  it('bar active, ☰ and ✕ are forwarded to the wallet', () => {
    send({ type: 'bapp:hello' });
    const el = mountBar(); el.active = 'wallet';
    window.dispatchEvent(new CustomEvent('bapp-menu'));
    window.dispatchEvent(new CustomEvent('bapp-close'));
    const types = parentWin.postMessage.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['bapp:ready', 'bapp:active', 'bapp:menu', 'bapp:close']);
    expect(el.hasAttribute('data-in-wallet')).toBe(true);
  });
});

describe('native webview (UA) mode', () => {
  it('detects from UA and only accepts same-window, same-origin messages', () => {
    const b = new ShellBridge({ manifest: manifest(), userAgent: 'Mozilla/5.0 bWallet/5.1.2' }).start();
    expect(b.inWallet).toBe(true);
    expect(walletState().via).toBe('ua');
    const nav = vi.fn(); window.addEventListener('bapp-navigate', (e) => { e.preventDefault(); nav(); });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'bapp:navigate', slot: 'feed' }, origin: 'https://evil.example', source: window }));
    expect(nav).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'bapp:navigate', slot: 'feed' }, origin: location.origin, source: window }));
    expect(nav).toHaveBeenCalledTimes(1);
    b.stop();
  });
});
