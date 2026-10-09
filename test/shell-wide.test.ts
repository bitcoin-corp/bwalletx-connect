// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ShellBridge, _resetWalletState, defineBappShell, layoutState, parseManifest, sectionPath, validateManifest, wideSections,
  type BappManifest,
} from '../src/shell/index';

const sample = JSON.parse(readFileSync(resolve(__dirname, '../examples/bapp.bmovies.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(sample));
const WALLET = 'https://web.bwalletx.com';
const WIDE = {
  sidebar: { label: 'bMovies', icon: '/icons/bmovies-64.png', badge: 'live' },
  sections: [
    { id: 'feed', label: 'Feed', path: '/feed', icon: 'home' },
    { id: 'make', label: 'Make', path: '/make', icon: 'spark' },
    { id: 'chat', label: 'Chat', path: '/chat', icon: 'chat' },
  ],
  panes: 'list-detail',
  minWidth: 720,
};
const wideManifest = (): BappManifest => parseManifest({ ...clone(), wide: WIDE });

beforeAll(() => defineBappShell());
afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-bwx-in-wallet');
  document.documentElement.removeAttribute('data-bwx-layout');
  _resetWalletState();
  vi.restoreAllMocks();
});

describe('wide manifest block', () => {
  it('accepts a full wide block', () => {
    const r = validateManifest({ ...clone(), wide: WIDE });
    expect(r.ok).toBe(true);
    expect(r.manifest!.wide).toEqual(WIDE);
  });

  it('applies defaults (panes single, minWidth 720)', () => {
    const r = validateManifest({ ...clone(), wide: {} });
    expect(r.ok && r.manifest.wide).toEqual({ panes: 'single', minWidth: 720 });
  });

  it.each([
    [{ panes: 'grid' }, /wide\.panes/],
    [{ minWidth: 100 }, /wide\.minWidth/],
    [{ minWidth: 800.5 }, /wide\.minWidth/],
    [{ sections: [] }, /1\.\.16/],
    [{ sections: [{ id: 'Feed!', label: 'F', path: '/f' }] }, /sections\[0\]\.id/],
    [{ sections: [{ id: 'a', label: 'A', path: '/a' }, { id: 'a', label: 'B', path: '/b' }] }, /duplicate/],
    [{ sections: [{ id: 'a', label: 'A', path: 'https://evil.example/' }] }, /sections\[0\]\.path/],
    [{ sections: [{ id: 'a', label: 'A', path: '//evil.example' }] }, /sections\[0\]\.path/],
    [{ sections: [{ id: 'a', label: 'A', path: '/a', icon: 'javascript:x' }] }, /sections\[0\]\.icon/],
    [{ sidebar: { icon: 'https://evil.example/i.png' } }, /sidebar\.icon/],
    [{ sidebar: { badge: -1 } }, /sidebar\.badge/],
    [{ extra: 1 }, /unknown field "wide\.extra"/],
    ['wide', /wide must be an object/],
  ])('rejects %j', (wide, re) => {
    const r = validateManifest({ ...clone(), wide });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(re);
  });

  it('wideSections falls back to the v1 slots', () => {
    const v1 = parseManifest(clone());
    const ids = wideSections(v1).map((s) => s.id);
    expect(ids).not.toContain('b');
    expect(ids.length).toBeGreaterThan(0);
    for (const s of wideSections(v1)) expect(sectionPath(v1, s.id)).toBe(v1.slots[s.id as 'feed'].path);
    expect(wideSections(wideManifest()).map((s) => s.id)).toEqual(['feed', 'make', 'chat']);
    expect(sectionPath(wideManifest(), 'nope')).toBeNull();
    expect(sectionPath(wideManifest(), { id: 'feed' })).toBeNull();
  });
});

describe('ShellBridge v2', () => {
  let parentWin: { postMessage: ReturnType<typeof vi.fn> };
  let bridge: ShellBridge;
  beforeEach(() => {
    parentWin = { postMessage: vi.fn() };
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parentWin as unknown as Window);
    bridge = new ShellBridge({ manifest: wideManifest(), userAgent: 'Mozilla/5.0 Chrome' }).start();
  });
  afterEach(() => bridge.stop());
  const send = (data: unknown, origin = WALLET, source: unknown = parentWin) =>
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));

  it('bapp:layout sets data-bwx-layout and fires bapp-layout; bar and topbar hide in wide', () => {
    document.body.innerHTML = '<bwalletx-bar></bwalletx-bar><bwalletx-topbar></bwalletx-topbar>';
    const seen = vi.fn(); window.addEventListener('bapp-layout', seen);
    send({ type: 'bapp:hello', v: 2 });
    send({ type: 'bapp:layout', v: 2, layout: 'wide', width: 1280.4, standalone: true });
    expect(document.documentElement.getAttribute('data-bwx-layout')).toBe('wide');
    expect(document.documentElement.hasAttribute('data-bwx-standalone')).toBe(true);
    expect(layoutState()).toEqual({ layout: 'wide', width: 1280, standalone: true });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(document.querySelector('bwalletx-bar')!.hasAttribute('data-wide')).toBe(true);
    expect(document.querySelector('bwalletx-topbar')!.hasAttribute('data-wide')).toBe(true);
    send({ type: 'bapp:layout', v: 2, layout: 'phone', width: 390 });
    expect(document.documentElement.getAttribute('data-bwx-layout')).toBe('phone');
    expect(document.documentElement.hasAttribute('data-bwx-standalone')).toBe(false);
    expect(document.querySelector('bwalletx-topbar')!.hasAttribute('data-wide')).toBe(false);
    window.removeEventListener('bapp-layout', seen);
  });

  it('layout is ignored before the handshake, from other origins, and with bad values', () => {
    send({ type: 'bapp:layout', v: 2, layout: 'wide' });
    expect(document.documentElement.hasAttribute('data-bwx-layout')).toBe(false);
    send({ type: 'bapp:hello' });
    send({ type: 'bapp:layout', v: 2, layout: 'wide' }, 'https://evil.example');
    send({ type: 'bapp:layout', v: 2, layout: 'huge' });
    expect(document.documentElement.hasAttribute('data-bwx-layout')).toBe(false);
  });

  it('navigate {section}: manifest sections only, never URLs; replies bapp:active v2', () => {
    send({ type: 'bapp:hello' });
    const nav = vi.fn();
    const h = (e: Event) => { e.preventDefault(); nav((e as CustomEvent).detail); };
    window.addEventListener('bapp-navigate', h);
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    send({ type: 'bapp:navigate', v: 2, section: 'make' });
    expect(nav).toHaveBeenCalledWith({ section: 'make', path: '/make', source: 'wallet' });
    expect(parentWin.postMessage).toHaveBeenLastCalledWith({ type: 'bapp:active', v: 2, section: 'make' }, WALLET);
    nav.mockClear();
    send({ type: 'bapp:navigate', v: 2, section: 'https://evil.example/' });
    send({ type: 'bapp:navigate', v: 2, section: 'nope' });
    send({ type: 'bapp:navigate', v: 2, section: 'feed', path: 'https://evil.example/' });
    expect(nav.mock.calls).toEqual([[{ section: 'feed', path: '/feed', source: 'wallet' }]]);
    expect(assign).not.toHaveBeenCalled();
    window.removeEventListener('bapp-navigate', h);
  });

  it('navigate {section} without preventDefault assigns the manifest path', () => {
    send({ type: 'bapp:hello' });
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    send({ type: 'bapp:navigate', v: 2, section: 'chat' });
    expect(assign).toHaveBeenCalledWith('/chat');
  });

  it('setActiveSection, setBadge, setTitle post to the exact wallet origin', () => {
    bridge.setBadge(3); // before handshake: nothing
    expect(parentWin.postMessage).not.toHaveBeenCalled();
    send({ type: 'bapp:hello' });
    bridge.setActiveSection('feed');
    bridge.setActiveSection('unknown'); // ignored
    bridge.setBadge(4.7);
    bridge.setBadge(-2);
    bridge.setTitle('  Film\u0000 one  ');
    window.dispatchEvent(new CustomEvent('bapp-active', { detail: { section: 'chat' } }));
    const msgs = parentWin.postMessage.mock.calls.map((c) => c[0]);
    expect(parentWin.postMessage.mock.calls.every((c) => c[1] === WALLET)).toBe(true);
    expect(msgs.slice(1)).toEqual([
      { type: 'bapp:active', v: 2, section: 'feed' },
      { type: 'bapp:badge', v: 2, count: 4 },
      { type: 'bapp:badge', v: 2, count: 0 },
      { type: 'bapp:title', v: 2, title: 'Film  one' },
      { type: 'bapp:active', v: 2, section: 'chat' },
    ]);
  });

  it('hello reply carries the active section', () => {
    send({ type: 'bapp:hello' });
    bridge.setActiveSection('make');
    send({ type: 'bapp:hello' });
    expect(parentWin.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'bapp:ready', section: 'make' }), WALLET);
  });
});
