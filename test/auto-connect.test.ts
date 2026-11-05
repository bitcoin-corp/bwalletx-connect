// @vitest-environment happy-dom
/**
 * 0.6.0 auto-connect (RB, 5 Nov 2026):
 *   - returning visitors go straight to the wallet they explicitly picked on this origin before;
 *   - only the wallet TYPE is remembered, never a key; a bare window.CWI is never remembered;
 *   - nothing that could prompt fires on load (only discovery, to attach a wallet to a live session);
 *   - a remembered wallet that isn't bWalletX shows "Some features need bWalletX · Switch";
 *   - the one-sheet sign-in is unchanged.
 */
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { brc100Option, discoverWallets, type WalletOption } from '../src/wallets';
import {
  attachRemembered, decideWallet, forgetWalletChoice, matchRemembered, planAutoConnect, rememberWalletChoice, rememberedWalletChoice,
  WALLET_CHOICE_KEY,
} from '../src/choice';
import { runConnect } from '../src/connect-flow';
import { defineBwalletxSignin, SWITCH_NOTE } from '../src/element';
import { createChallenge, memoryStore, verifySignIn } from '../src/server';

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
const g = window as unknown as { CWI?: unknown };
const KEYISH = /0[23][0-9a-f]{64}/i;

function fakeWallet() {
  const root = PrivateKey.fromRandom();
  const pw = new ProtoWallet(root);
  const calls: string[] = [];
  const wallet = {
    isAuthenticated: async () => (calls.push('isAuthenticated'), { authenticated: true }),
    waitForAuthentication: async () => (calls.push('waitForAuthentication'), { authenticated: true }),
    getPublicKey: async (a: Parameters<ProtoWallet['getPublicKey']>[0]) => (calls.push('getPublicKey'), pw.getPublicKey(a)),
    createSignature: async (a: Parameters<ProtoWallet['createSignature']>[0]) => (calls.push('createSignature'), pw.createSignature(a)),
  } as unknown as WalletInterface;
  return { wallet, calls, key: root.toPublicKey().toString() };
}
const stops: (() => void)[] = [];
function announce(rdns: string, name = rdns) {
  const w = fakeWallet();
  const f = () => window.dispatchEvent(Object.assign(new Event('brc100:announceWallet'), { detail: { info: { rdns, name }, wallet: w.wallet } }));
  window.addEventListener('brc100:requestWallet', f);
  stops.push(() => window.removeEventListener('brc100:requestWallet', f));
  return w;
}
const bwalletx = () => announce('com.bwalletx.extension', 'bWalletX');
const yours = () => announce('io.yours', 'Yours');
const noPick = async (): Promise<WalletOption | null> => {
  throw new Error('the chooser must not open');
};
const post = async (url: string, body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (url === '/c') return (await createChallenge({ origin: ORIGIN, identityKey: b.identityKey as string | undefined, store })) as unknown as Record<string, unknown>;
  const k = await verifySignIn({ origin: ORIGIN, store, ...(b as { identityKey: string; nonce: string; signature: number[] }) });
  if (!k) throw Object.assign(new Error('sign-in failed'), { status: 401 });
  return { identityKey: k };
};

let requests: string[] = [];
const routes = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/c') return json(await createChallenge({ origin: ORIGIN, identityKey: body.identityKey, store }));
      if (url === '/v') {
        const k = await verifySignIn({ origin: ORIGIN, store, ...body });
        return k ? json({ identityKey: k }) : json({ error: 'sign-in failed' }, 401);
      }
      if (url === '/out') return json({ ok: true });
      throw new TypeError('network off');
    }),
  );
beforeEach(() => {
  requests = [];
  localStorage.clear();
  routes();
});
afterEach(() => {
  while (stops.length) stops.pop()!();
  delete g.CWI;
  document.body.innerHTML = '';
  document.querySelectorAll('[data-bwalletx-menu]').forEach((e) => e.remove());
  vi.unstubAllGlobals();
});
const localHits = () => requests.filter((u) => /localhost|127\.0\.0\.1/.test(u));

describe('the remembered choice: the wallet TYPE per origin, never a key', () => {
  it('an explicit pick from the chooser is remembered as { type, substrate } only', async () => {
    const y = yours();
    const list = await discoverWallets({ ms: 20 });
    const r = await runConnect({ list, remember: true, pick: async (l) => l.find((o) => o.id === 'io.yours')!, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(r?.identityKey).toBe(y.key);
    const raw = localStorage.getItem(WALLET_CHOICE_KEY)!;
    expect(JSON.parse(raw)).toEqual({ type: 'io.yours', substrate: 'injected', v: 1 });
    expect(raw).not.toMatch(KEYISH);
    expect(rememberedWalletChoice()).toEqual({ type: 'io.yours', substrate: 'injected' });
  });

  it('a bare window.CWI is never remembered (whoever holds it next time may be another wallet)', () => {
    rememberWalletChoice(brc100Option(fakeWallet().wallet, { id: 'window.CWI', name: 'Browser wallet', substrate: 'window.CWI' }));
    expect(localStorage.getItem(WALLET_CHOICE_KEY)).toBeNull();
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ type: 'window.CWI', substrate: 'window.CWI' }));
    expect(rememberedWalletChoice()).toBeNull();
  });

  it('a key-shaped or malformed value is ignored', () => {
    const key = fakeWallet().key;
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ type: key, substrate: 'injected' }));
    expect(rememberedWalletChoice()).toBeNull();
    localStorage.setItem(WALLET_CHOICE_KEY, '{nope');
    expect(rememberedWalletChoice()).toBeNull();
    localStorage.removeItem(WALLET_CHOICE_KEY);
    rememberWalletChoice(brc100Option(fakeWallet().wallet, { id: key, rdns: key, name: 'x', substrate: 'injected' }));
    expect(localStorage.getItem(WALLET_CHOICE_KEY)).toBeNull();
  });

  it('a wallet connected without a pick (0.5.5 legacy auto-choice) is not remembered unless it is bWalletX', async () => {
    const y = brc100Option(fakeWallet().wallet, { id: 'io.yours', rdns: 'io.yours', name: 'Yours', substrate: 'injected' });
    await runConnect({ list: [y], fastPath: false, remember: true, pick: noPick, post });
    expect(rememberedWalletChoice()).toBeNull();
  });
});

describe('returning visitor: the tap goes straight to the remembered wallet', () => {
  it('remembered Yours: no chooser, even with bWalletX installed; one sheet', async () => {
    rememberWalletChoice(brc100Option(fakeWallet().wallet, { id: 'io.yours', rdns: 'io.yours', name: 'Yours', substrate: 'injected' }));
    const b = bwalletx();
    const y = yours();
    const list = await discoverWallets({ ms: 20 });
    const r = await runConnect({ list, remembered: rememberedWalletChoice(), remember: true, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(r).toMatchObject({ reason: 'remembered', walletType: 'io.yours', identityKey: y.key, signedIn: true });
    expect(y.calls.filter((c) => c === 'getPublicKey' || c === 'createSignature').sort()).toEqual(['createSignature', 'getPublicKey']);
    expect(b.calls).toEqual([]);
  });

  it('the remembered wallet is gone: bWalletX if here, else the chooser; never another wallet', async () => {
    const remembered = { type: 'io.yours', substrate: 'injected' as const };
    const other = announce('com.metanet.desktop', 'Metanet');
    let list = await discoverWallets({ ms: 20 });
    expect(decideWallet(list, { remembered })).toEqual({ option: null, reason: 'chooser' });
    bwalletx();
    list = await discoverWallets({ ms: 20 });
    expect(decideWallet(list, { remembered }).reason).toBe('bwalletx');
    expect(other.calls).toEqual([]);
  });

  it('"Switch" (preferBwalletX) skips the remembered wallet and remembers bWalletX', async () => {
    rememberWalletChoice(brc100Option(fakeWallet().wallet, { id: 'io.yours', rdns: 'io.yours', name: 'Yours', substrate: 'injected' }));
    const b = bwalletx();
    yours();
    const list = await discoverWallets({ ms: 20 });
    const r = await runConnect({ list, remembered: rememberedWalletChoice(), preferBwalletX: true, remember: true, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(r).toMatchObject({ reason: 'bwalletx', identityKey: b.key });
    expect(rememberedWalletChoice()).toEqual({ type: 'bwalletx', substrate: 'extension' });
  });

  it('a remembered desktop wallet probes localhost only when connected (after the tap)', async () => {
    const d = matchRemembered([], { type: 'desktop', substrate: 'json-api' })!;
    expect(d.id).toBe('desktop');
    await tick(10);
    expect(localHits()).toEqual([]);
    await expect(d.connect()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(localHits().length).toBeGreaterThan(0);
  });
});

describe('on load: nothing that could prompt', () => {
  it('planAutoConnect: attach only to a live session with an injected wallet; everything else waits for a tap', () => {
    const inj = { type: 'io.yours', substrate: 'injected' as const };
    expect(planAutoConnect({ remembered: null, signedIn: true }).action).toBe('none');
    expect(planAutoConnect({ remembered: inj, signedIn: true, enabled: false }).action).toBe('none');
    expect(planAutoConnect({ remembered: inj, signedIn: true })).toEqual({ action: 'attach', remembered: inj, needsBwalletX: true });
    expect(planAutoConnect({ remembered: inj, signedIn: false }).action).toBe('wait-for-tap');
    expect(planAutoConnect({ remembered: { type: 'desktop', substrate: 'json-api' }, signedIn: true }).action).toBe('wait-for-tap');
    expect(planAutoConnect({ remembered: { type: 'bwalletx', substrate: 'pairing' }, signedIn: true }).action).toBe('wait-for-tap');
    expect(planAutoConnect({ remembered: { type: 'bwalletx', substrate: 'extension' }, signedIn: true })).toMatchObject({ action: 'attach', needsBwalletX: false });
  });

  it('attachRemembered finds the wallet with zero wallet calls and no localhost; desktop is never attached', async () => {
    const b = bwalletx();
    const opt = await attachRemembered({ type: 'bwalletx', substrate: 'extension' }, { ms: 20 });
    expect(opt?.wallet).toBe(b.wallet);
    expect(b.calls).toEqual([]);
    expect(await attachRemembered({ type: 'desktop', substrate: 'json-api' }, { ms: 20 })).toBeNull();
    await tick(10);
    expect(localHits()).toEqual([]);
  });

  it('attachRemembered never takes window.CWI for a remembered wallet that is not announced', async () => {
    g.CWI = fakeWallet().wallet;
    expect(await attachRemembered({ type: 'io.yours', substrate: 'injected' }, { ms: 20 })).toBeNull();
    expect(await attachRemembered({ type: 'bwalletx', substrate: 'extension' }, { ms: 20 })).toBeNull();
  });
});

describe('<bwalletx-signin> 0.6.0: remembered tap, Switch note, Disconnect forgets', () => {
  type El = HTMLElement & { button: HTMLButtonElement; state: string; signOut(): Promise<void>; switchToBwalletX(): Promise<void> };
  beforeAll(() => {
    defineBwalletxSignin();
  });
  const mount = (attrs: Record<string, string>) => {
    const el = document.createElement('bwalletx-signin') as El;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    return el;
  };
  const q = (el: El, sel: string) => el.shadowRoot!.querySelector<HTMLElement>(sel);
  const rememberYours = () => rememberWalletChoice(brc100Option(fakeWallet().wallet, { id: 'io.yours', rdns: 'io.yours', name: 'Yours', substrate: 'injected' }));
  const base = { 'challenge-url': '/c', 'verify-url': '/v', 'logout-url': '/out', 'lookup-url': 'off' };

  it('remembered Yours: the note shows; nothing is asked on load; the tap goes straight to Yours', async () => {
    rememberYours();
    const b = bwalletx();
    const y = yours();
    const el = mount(base);
    await tick(30);
    expect(q(el, '.sw')?.textContent).toBe(`${SWITCH_NOTE} · Switch`);
    expect(y.calls).toEqual([]);
    expect(b.calls).toEqual([]);
    el.button.click();
    await until(() => el.state === 'signed-in');
    expect(document.querySelector('[data-bwx-chooser]')).toBeNull();
    expect(y.calls).toContain('createSignature');
    expect(b.calls).toEqual([]);
  });

  it('no note for bWalletX, or with switch-note="off", or at sm', () => {
    rememberWalletChoice(brc100Option(fakeWallet().wallet, { id: 'com.bwalletx.extension', name: 'bWalletX', isBwalletX: true, substrate: 'extension' }));
    expect(q(mount(base), '.sw')).toBeNull();
    rememberYours();
    expect(q(mount({ ...base, 'switch-note': 'off' }), '.sw')).toBeNull();
    expect(q(mount({ ...base, size: 'sm' }), '.sw')).toBeNull();
    expect(q(mount({ ...base, size: 'sm', 'switch-note': 'on' }), '.sw')).not.toBeNull();
  });

  it('Switch → the bWalletX sheet; bWalletX is remembered and the note goes', async () => {
    rememberYours();
    const b = bwalletx();
    const y = yours();
    const el = mount(base);
    const modes: string[] = [];
    el.addEventListener('bwalletx-signin', (e) => modes.push((e as CustomEvent<{ mode: string }>).detail.mode));
    q(el, '.sw [data-act=switch]')!.click();
    await until(() => el.state === 'signed-in');
    expect(modes).toEqual(['bwalletx']);
    expect(b.calls).toContain('createSignature');
    expect(y.calls).toEqual([]);
    expect(rememberedWalletChoice()).toEqual({ type: 'bwalletx', substrate: 'extension' });
  });

  it('signed in with another wallet: the menu offers "Switch to bWalletX"; Disconnect forgets the choice', async () => {
    rememberYours();
    yours();
    const el = mount(base);
    el.button.click();
    await until(() => el.state === 'signed-in');
    el.button.click();
    const menu = document.querySelector('[data-bwalletx-menu]')!.shadowRoot!;
    expect(menu.textContent).toContain(SWITCH_NOTE);
    expect(Array.from(menu.querySelectorAll('[role=menuitem]')).map((b) => b.textContent)).toEqual(['Switch to bWalletX', 'Copy key', 'Disconnect']);
    await el.signOut();
    expect(rememberedWalletChoice()).toBeNull();
    expect(localStorage.getItem(WALLET_CHOICE_KEY)).toBeNull();
  });

  it('remember="off": nothing read, nothing written', async () => {
    bwalletx();
    const el = mount({ ...base, remember: 'off' });
    el.button.click();
    await until(() => el.state === 'signed-in');
    expect(localStorage.getItem(WALLET_CHOICE_KEY)).toBeNull();
    forgetWalletChoice();
  });

  it('bWalletX fast path is remembered as bwalletx (never a key)', async () => {
    bwalletx();
    const el = mount(base);
    el.button.click();
    await until(() => el.state === 'signed-in');
    expect(localStorage.getItem(WALLET_CHOICE_KEY)).toBe(JSON.stringify({ type: 'bwalletx', substrate: 'extension', v: 1 }));
  });
});
