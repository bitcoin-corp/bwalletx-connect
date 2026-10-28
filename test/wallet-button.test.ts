// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { _resetBwalletxButtons, defineBwalletxButton, getUrlFor, handleLabel, stateFor } from '../src/wallet-button';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
type Btn = HTMLElement & { state: string };

beforeAll(() => defineBwalletxButton());
afterEach(() => { document.body.innerHTML = ''; _resetBwalletxButtons(); vi.restoreAllMocks(); delete (window as { CWI?: unknown }).CWI; try { localStorage.clear(); } catch { /* */ } });

describe('pure helpers', () => {
  it('platform get links', () => {
    expect(getUrlFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('https://bwalletx.com/iphone');
    expect(getUrlFor('Mozilla/5.0 (Linux; Android 14) Chrome/130.0')).toBe('https://bwalletx.com/android');
    expect(getUrlFor('Mozilla/5.0 (Macintosh) AppleWebKit Chrome/130.0 Safari')).toBe('https://bwalletx.com/extension');
    expect(getUrlFor('Mozilla/5.0 (Macintosh) Version/18 Safari/605')).toBe('https://bwalletx.com/get');
    expect(getUrlFor('Mozilla/5.0 (Windows) Chrome/130.0 Edg/130.0')).toBe('https://bwalletx.com/get');
    expect(getUrlFor('Mozilla/5.0 (Macintosh) Version/18 Safari/605', true)).toBe('https://bwalletx.com/iphone');
  });
  it('state by detection', () => {
    expect(stateFor({ connected: true, found: false, phone: false })).toBe('connected');
    expect(stateFor({ connected: false, found: null, phone: false })).toBe('checking');
    expect(stateFor({ connected: false, found: null, phone: true })).toBe('available');
    expect(stateFor({ connected: false, found: false, phone: false })).toBe('none');
    expect(stateFor({ connected: false, found: false, phone: true })).toBe('available');
    expect(stateFor({ connected: false, found: true, phone: false })).toBe('available');
  });
  it('handle labels', () => {
    const k = '02' + 'ab'.repeat(32);
    expect(handleLabel(k, 'alice@bwalletx.com')).toBe('$alice');
    expect(handleLabel(k, 'bob@handcash.io')).toBe('bob@handcash.io');
    expect(handleLabel(k, null)).toBe('02abab…abab');
  });
});

describe('<bwalletx-button>', () => {
  it('no wallet: one Get bWalletX link', async () => {
    const el = document.createElement('bwalletx-button') as Btn;
    el.setAttribute('discover-ms', '20');
    document.body.appendChild(el);
    await tick(120);
    expect(el.state).toBe('none');
    const a = el.shadowRoot!.querySelector('a')!;
    expect(a.textContent).toContain('Get bWalletX');
    expect(el.shadowRoot!.querySelectorAll('a,button').length).toBe(1);
  });

  it('guard: a second button and legacy controls in the same header hide, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    document.body.innerHTML = '<header><span data-bwx-connect></span><a id="get" href="https://bwalletx.com/get">Get bWalletX</a><bwalletx-button discover-ms="20"></bwalletx-button></header><main><a id="hero" href="https://bwalletx.com/get">Get</a></main>';
    const two = document.createElement('bwalletx-button');
    document.body.appendChild(two);
    expect((document.querySelector('[data-bwx-connect]') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('get') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('hero') as HTMLElement).hidden).toBe(false); // page content outside the nav stays
    expect(two.hidden).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
