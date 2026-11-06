// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://example.com/"}
/**
 * 0.7.0 "Use Metanet Desktop or another BRC-100 wallet" (owner, 6 Nov 2026), the rules of the live bChatX door:
 *   1. bWalletX stays the default, found by its own announcement only; the button's discovery never picks Metanet;
 *   2. an explicit, visible choice, pinned to json-api on localhost:3321, connecting on its own tap only (no :3321 call
 *      on page load);
 *   3. after a connect: the wallet TYPE for this origin, plus the identity keys known here;
 *   4. back with Metanet remembered: one silent attempt per page load, 2 s, a known key only, silent on failure;
 *   5. "Not you? Use another wallet" and Disconnect forget the choice;
 *   6. hidden on phones and inside any frame;
 *   7. the minimum asked: no protocol permission requests at connect, one request at a time;
 *   8. no coins for the fee: one plain message.
 * Metanet Desktop is simulated at the fetch layer (POST http://localhost:3321/<call>), so the real
 * WalletClient('json-api') / HTTPWalletJSON path runs.
 */
import { PrivateKey, ProtoWallet, WERR_INSUFFICIENT_FUNDS, type WalletInterface } from '@bsv/sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectMetanetDesktop, inAnyFrame, isKnownIdentityKey, knownIdentityKeys, metanetOffered, metanetOption, rememberKnownIdentityKey,
  resetLogoutWarning, resetSilentAttempt, trySilentMetanet, warnIfNoLogout, KNOWN_KEYS_KEY, METANET_LABEL, METANET_NOTE, METANET_SILENT_MS, METANET_UNREACHABLE, NOT_YOU_LABEL,
} from '../src/metanet';
import { decideWallet, forgetWalletChoice, matchRemembered, planAutoConnect, rememberedWalletChoice, WALLET_CHOICE_KEY } from '../src/choice';
import { runConnect, runSilentMetanet } from '../src/connect-flow';
import { chooseWallet } from '../src/modal';
import { autoChoice, brc100Option, desktopOption, discoverWallets, isLocalDesktop, type WalletOption } from '../src/wallets';
import { defineBwalletxSignin } from '../src/element';
import { pay, NO_COINS_TEXT, PaymentError } from '../src/pay';
import { LOGIN_PROTOCOL } from '../src/signin';
import { createChallenge, memoryStore, verifySignIn } from '../src/server';

const ORIGIN = 'https://example.com';
const META = 'http://localhost:3321/';
const META_KEY = { type: 'metanet', substrate: 'json-api' as const };
const store = memoryStore({ quiet: true });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(5);
  }
};
const g = window as unknown as { CWI?: unknown };

/** What Metanet Desktop was asked, in order, with when each answer went back. */
type Call = { m: string; args: Record<string, unknown>; t: number; done?: number };

/** A Metanet Desktop on localhost:3321 (the BRC-100 JSON API), backed by a ProtoWallet. */
function fakeMetanet(o: { root?: PrivateKey; locked?: boolean; silentFor?: string[]; noCoins?: boolean } = {}) {
  const root = o.root ?? PrivateKey.fromRandom();
  const pw = new ProtoWallet(root) as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  const calls: Call[] = [];
  const answer = async (m: string, args: Record<string, unknown>): Promise<[number, unknown]> => {
    if (o.silentFor?.includes(m)) return new Promise(() => {}); // never answers
    if (m === 'getVersion') return [200, { version: 'metanet-1.0.0' }];
    if (m === 'isAuthenticated') return [200, { authenticated: !o.locked }];
    if (m === 'createAction' && o.noCoins) return [400, { isError: true, code: 7, message: 'Insufficient funds', totalSatoshisNeeded: 1100, moreSatoshisNeeded: 1100 }];
    if (typeof pw[m] !== 'function') return [400, { isError: true, code: 1, message: `${m} not supported` }];
    return [200, await pw[m].call(pw, args)];
  };
  const handle = async (m: string, args: Record<string, unknown>) => {
    const c: Call = { m, args, t: Date.now() };
    calls.push(c);
    const [status, body] = await answer(m, args);
    c.done = Date.now();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { root, key: root.toPublicKey().toString(), calls, handle, methods: () => calls.map((c) => c.m) };
}

let metanet: ReturnType<typeof fakeMetanet> | null = null;
let requests: string[] = [];
const localHits = () => requests.filter((u) => /localhost|127\.0\.0\.1/.test(u));
const siteHits = () => requests.filter((u) => u.startsWith('/'));

beforeAll(() => {
  defineBwalletxSignin();
});

beforeEach(() => {
  requests = [];
  metanet = null;
  localStorage.clear();
  resetSilentAttempt();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (url.startsWith(META)) {
        if (!metanet) throw new TypeError('Failed to fetch');
        return metanet.handle(url.slice(META.length), body);
      }
      if (url === '/c') return json(await createChallenge({ origin: ORIGIN, identityKey: body.identityKey, store }));
      if (url === '/v') {
        const k = await verifySignIn({ origin: ORIGIN, store, ...body });
        return k ? json({ identityKey: k }) : json({ error: 'sign-in failed' }, 401);
      }
      if (url === '/out') return json({ ok: true });
      throw new TypeError(`unexpected request ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete g.CWI;
  document.body.innerHTML = '';
  localStorage.clear();
});

const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw Object.assign(new Error(String(j.error)), { status: r.status });
  return j;
};
const noPick = async (): Promise<WalletOption | null> => {
  throw new Error('the chooser must not open');
};

type El = HTMLElement & {
  button: HTMLButtonElement; state: string; useMetanet(): Promise<void>; notYou(): void; signOut(): Promise<void>; account: { identityKey: string } | null;
};
function mount(attrs: Record<string, string> = {}): El {
  const el = document.createElement('bwalletx-signin') as El;
  for (const [k, v] of Object.entries({ 'challenge-url': '/c', 'verify-url': '/v', 'lookup-url': 'off', 'discover-ms': '20', ...attrs })) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}
const shadow = (el: HTMLElement) => el.shadowRoot!;
const metanetLink = (el: HTMLElement) => shadow(el).querySelector<HTMLElement>('[data-act=metanet]');
const notYouLink = (el: HTMLElement) => shadow(el).querySelector<HTMLElement>('[data-act=not-you]');

/** A wallet that announces itself like bWalletX (com.bwalletx.extension). */
function announceBwalletX() {
  const pw = new ProtoWallet(PrivateKey.fromRandom());
  const calls: string[] = [];
  const wallet = {
    isAuthenticated: async () => (calls.push('isAuthenticated'), { authenticated: true }),
    waitForAuthentication: async () => (calls.push('waitForAuthentication'), { authenticated: true }),
    getPublicKey: async (a: Parameters<ProtoWallet['getPublicKey']>[0]) => (calls.push('getPublicKey'), pw.getPublicKey(a)),
    createSignature: async (a: Parameters<ProtoWallet['createSignature']>[0]) => (calls.push('createSignature'), pw.createSignature(a)),
  } as unknown as WalletInterface;
  const f = () => window.dispatchEvent(Object.assign(new Event('brc100:announceWallet'), { detail: { info: { rdns: 'com.bwalletx.extension', name: 'bWalletX' }, wallet } }));
  window.addEventListener('brc100:requestWallet', f);
  stopAnnounce.push(() => window.removeEventListener('brc100:requestWallet', f));
  return { wallet, calls };
}
const stopAnnounce: (() => void)[] = [];
afterEach(() => {
  while (stopAnnounce.length) stopAnnounce.pop()!();
});

describe('1. bWalletX stays the default; discovery never picks Metanet', () => {
  it('a remembered Metanet is never the button\'s pick: bWalletX here → bWalletX, and nothing calls :3321', async () => {
    metanet = fakeMetanet();
    announceBwalletX();
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    const list = await discoverWallets({ ms: 20 });
    expect(matchRemembered(list, META_KEY)).toBeNull();
    expect(decideWallet(list, { remembered: rememberedWalletChoice() }).reason).toBe('bwalletx');
    const r = await runConnect({ list, remembered: rememberedWalletChoice(), remember: true, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(r).toMatchObject({ walletType: 'bwalletx', reason: 'bwalletx', signedIn: true });
    expect(localHits()).toEqual([]);
  });

  it('a Metanet that sets window.CWI is never taken for bWalletX, and is never connected unasked', async () => {
    metanet = fakeMetanet();
    g.CWI = { isAuthenticated: async () => ({ authenticated: true }) };
    const list = await discoverWallets({ ms: 20 });
    expect(list.find((o) => o.id === 'window.CWI')?.isBwalletX).toBe(false);
    const pick = vi.fn(async () => null);
    expect(await runConnect({ list, pick, post })).toBeNull();
    expect(pick).toHaveBeenCalledOnce(); // the chooser, Get bWalletX first; nothing connected
    expect(localHits()).toEqual([]);
  });

  it('the element: the gold button goes to bWalletX even with Metanet remembered and running', async () => {
    metanet = fakeMetanet();
    rememberKnownIdentityKey(metanet.key);
    const b = announceBwalletX();
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    resetSilentAttempt();
    const el = mount({ metanet: 'off' }); // no silent attempt here: only the tap is under test
    el.button.click();
    await until(() => el.state === 'signed-in');
    expect(b.calls).toContain('createSignature');
    expect(localHits()).toEqual([]);
  });
});

describe('2. an explicit choice, pinned to localhost:3321, on its own tap only', () => {
  it('the element shows the link and its note; a first visit makes no :3321 call on load', async () => {
    metanet = fakeMetanet();
    const el = mount();
    await tick(60);
    expect(metanetLink(el)?.textContent).toBe(METANET_LABEL);
    expect(shadow(el).textContent).toContain(METANET_NOTE);
    expect(METANET_LABEL).toBe('Use Metanet Desktop or another BRC-100 wallet');
    expect(METANET_NOTE).toBe('Metanet Desktop must be running on this computer');
    expect(localHits()).toEqual([]);
    expect(metanet.calls).toEqual([]);
  });

  it('a tap on the link signs in through Metanet, and only ever calls localhost:3321', async () => {
    metanet = fakeMetanet();
    const el = mount();
    const ev = vi.fn();
    el.addEventListener('bwalletx-signin', (e) => ev((e as CustomEvent).detail.mode));
    metanetLink(el)!.click();
    await until(() => el.state === 'signed-in');
    expect(ev).toHaveBeenCalledWith('metanet');
    expect(el.account?.identityKey).toBe(metanet.key);
    expect(localHits().length).toBeGreaterThan(0);
    expect(localHits().every((u) => u.startsWith(META))).toBe(true);
  });

  it('metanetOption() asks nothing until connect(); runConnect({ metanet }) picks it with no chooser', async () => {
    metanet = fakeMetanet();
    const opt = metanetOption();
    expect(opt).toMatchObject({ id: 'metanet', substrate: 'json-api', isBwalletX: false, kind: 'brc100' });
    await tick(10);
    expect(localHits()).toEqual([]);
    const r = await runConnect({ list: [], metanet: true, remember: true, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(r).toMatchObject({ walletType: 'metanet', substrate: 'json-api', reason: 'requested', signedIn: true, identityKey: metanet.key });
  });

  it('nothing on :3321 → the plain "open it" line after a tap, no fallback to any other wallet', async () => {
    const b = announceBwalletX();
    await expect(connectMetanetDesktop({ timeoutMs: 200 })).rejects.toMatchObject({ code: 'NOT_FOUND', message: METANET_UNREACHABLE });
    const el = mount();
    metanetLink(el)!.click();
    await until(() => el.state === 'error');
    expect(shadow(el).querySelector('[part=error]')!.textContent).toBe(METANET_UNREACHABLE);
    expect(b.calls).toEqual([]);
  });

  it('the chooser lists it (computers only) and calls :3321 only after the tap', async () => {
    metanet = fakeMetanet();
    const p = chooseWallet(await discoverWallets({ ms: 20 }));
    const row = document.querySelector<HTMLElement>('[data-wallet=metanet]')!;
    expect(row.textContent).toContain(METANET_LABEL);
    expect(row.textContent).toContain(METANET_NOTE);
    await tick(20);
    expect(localHits()).toEqual([]);
    row.click();
    const picked = (await p)!;
    await picked.connect();
    expect(localHits()[0]).toBe(`${META}getVersion`);
  });
});

describe('3. remembered: the wallet type, plus the identity keys known here', () => {
  it('after a connect: bwx:wallet holds the type only; bwx:known-keys holds public keys', async () => {
    metanet = fakeMetanet();
    await runConnect({ list: [], metanet: true, remember: true, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(JSON.parse(localStorage.getItem(WALLET_CHOICE_KEY)!)).toEqual({ type: 'metanet', substrate: 'json-api', v: 1 });
    expect(localStorage.getItem(WALLET_CHOICE_KEY)).not.toMatch(/0[23][0-9a-f]{64}/i);
    expect(knownIdentityKeys()).toEqual([metanet.key]);
    expect(isKnownIdentityKey(metanet.key)).toBe(true);
    expect(localStorage.getItem(KNOWN_KEYS_KEY)).not.toContain(metanet.root.toWif());
  });

  it('remember off: nothing is remembered', async () => {
    metanet = fakeMetanet();
    await runConnect({ list: [], metanet: true, remember: false, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(localStorage.getItem(WALLET_CHOICE_KEY)).toBeNull();
    expect(knownIdentityKeys()).toEqual([]);
  });

  it('known keys: compressed public keys only, newest first, at most 8', () => {
    rememberKnownIdentityKey('not a key');
    rememberKnownIdentityKey(PrivateKey.fromRandom().toWif());
    expect(knownIdentityKeys()).toEqual([]);
    const keys = Array.from({ length: 10 }, () => PrivateKey.fromRandom().toPublicKey().toString());
    keys.forEach(rememberKnownIdentityKey);
    expect(knownIdentityKeys()).toEqual(keys.slice(-8).reverse());
  });
});

describe('4. a return visit: one silent attempt, 2 s, a known key only, silent on failure', () => {
  const remembered = (key?: string) => {
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    if (key) rememberKnownIdentityKey(key);
  };

  it('planAutoConnect: Metanet remembered on a computer → silent-metanet, never the Switch note', () => {
    expect(planAutoConnect({ remembered: META_KEY, signedIn: false, metanetHere: true })).toEqual({ action: 'silent-metanet', remembered: META_KEY, needsBwalletX: false });
    expect(planAutoConnect({ remembered: META_KEY, signedIn: true, metanetHere: true }).action).toBe('silent-metanet');
    expect(planAutoConnect({ remembered: META_KEY, signedIn: false, metanetHere: false }).action).toBe('none');
    expect(planAutoConnect({ remembered: META_KEY, signedIn: false, enabled: false }).action).toBe('none');
    expect(METANET_SILENT_MS).toBe(2000);
  });

  it('a known key: the element signs in silently, with no tap', async () => {
    metanet = fakeMetanet();
    remembered(metanet.key);
    const el = mount();
    await until(() => el.state === 'signed-in');
    expect(el.account?.identityKey).toBe(metanet.key);
    expect(siteHits()).toEqual(['/c', '/v']);
  });

  it('an unknown key: stops before /challenge, no signature, no error; the normal choice stays', async () => {
    metanet = fakeMetanet();
    remembered(PrivateKey.fromRandom().toPublicKey().toString());
    const errors = vi.fn();
    const el = mount();
    el.addEventListener('bwalletx-error', errors);
    await until(() => metanet!.methods().includes('getPublicKey'));
    await tick(50);
    expect(el.state).toBe('signed-out');
    expect(metanet.methods()).not.toContain('createSignature');
    expect(siteHits()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(shadow(el).querySelector('[part=error]')).toBeNull();
    expect(metanetLink(el)).not.toBeNull(); // the normal choice: a tap is needed now
  });

  it('at most one attempt per page load, however many buttons mount', async () => {
    metanet = fakeMetanet();
    remembered(PrivateKey.fromRandom().toPublicKey().toString());
    mount();
    mount();
    await tick(150);
    expect(metanet.methods().filter((m) => m === 'getVersion')).toHaveLength(1);
    expect(await trySilentMetanet()).toEqual({ ok: false, stop: 'used' });
  });

  it('a nav-size button (no room for "Not you?") or metanet="off" makes no silent attempt', async () => {
    metanet = fakeMetanet();
    remembered(metanet.key);
    mount({ size: 'sm' });
    mount({ metanet: 'off' });
    await tick(80);
    expect(localHits()).toEqual([]);
  });

  it('a slow or absent Metanet: gives up inside the window, no retry loop', async () => {
    metanet = fakeMetanet({ silentFor: ['getVersion'] });
    remembered(metanet.key);
    const t = Date.now();
    expect(await trySilentMetanet({ windowMs: 80 })).toEqual({ ok: false, stop: 'slow' });
    expect(Date.now() - t).toBeLessThan(1000);
    await tick(100);
    expect(metanet.methods()).toEqual(['getVersion']);
    resetSilentAttempt();
    metanet = null;
    expect(await trySilentMetanet()).toEqual({ ok: false, stop: 'unreachable' });
  });

  it('locked: stops without asking it to unlock (no prompt on load)', async () => {
    metanet = fakeMetanet({ locked: true });
    remembered(metanet.key);
    expect(await trySilentMetanet()).toEqual({ ok: false, stop: 'locked' });
    expect(metanet.methods()).toEqual(['getVersion', 'isAuthenticated']);
  });

  it('with a session: attaches the wallet only when it holds the session\'s key, and signs nothing', async () => {
    metanet = fakeMetanet();
    remembered(metanet.key);
    const r = await runSilentMetanet({ sessionKey: metanet.key, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(r).toMatchObject({ signedIn: true, identityKey: metanet.key, walletType: 'metanet' });
    expect(metanet.methods()).not.toContain('createSignature');
    resetSilentAttempt();
    expect(await runSilentMetanet({ sessionKey: PrivateKey.fromRandom().toPublicKey().toString() })).toBeNull();
  });
});

describe('5. "Not you? Use another wallet" and Disconnect forget the choice', () => {
  it('"Not you?" shows with Metanet remembered, forgets it, and the button carries on as normal', async () => {
    metanet = fakeMetanet();
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    const el = mount();
    await tick(60);
    expect(notYouLink(el)?.textContent).toBe(NOT_YOU_LABEL);
    notYouLink(el)!.click();
    expect(rememberedWalletChoice()).toBeNull();
    expect(notYouLink(el)).toBeNull();
    expect(metanetLink(el)).not.toBeNull();
  });

  it('"Not you?" during the silent sign-in lands nobody', async () => {
    metanet = fakeMetanet({ silentFor: ['createSignature'] });
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    rememberKnownIdentityKey(metanet.key);
    const el = mount();
    await until(() => el.state === 'pending');
    notYouLink(el)!.click();
    expect(el.state).toBe('signed-out');
    expect(rememberedWalletChoice()).toBeNull();
  });

  it('runSilentMetanet: abandoned after the verify route answered → that session is ended (logout)', async () => {
    metanet = fakeMetanet();
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    rememberKnownIdentityKey(metanet.key);
    let abandoned = false;
    const logout = vi.fn(async () => undefined);
    const r = await runSilentMetanet({
      challengeUrl: '/c', verifyUrl: '/v',
      post: async (u, b) => { const j = await post(u, b); if (u === '/v') abandoned = true; return j; },
      isAbandoned: () => abandoned, logout,
    });
    expect(r).toBeNull();
    expect(logout).toHaveBeenCalledOnce();
  });

  it('Disconnect forgets it', async () => {
    metanet = fakeMetanet();
    const el = mount({ 'logout-url': '/out' });
    metanetLink(el)!.click();
    await until(() => el.state === 'signed-in');
    expect(rememberedWalletChoice()).toEqual(META_KEY);
    await el.signOut();
    expect(rememberedWalletChoice()).toBeNull();
    forgetWalletChoice();
  });
});

describe('6. hidden on phones and inside any frame', () => {
  const nav = (ua: string, maxTouchPoints = 0) => ({ userAgent: ua, maxTouchPoints }) as Navigator;
  const top = { self: 1, top: 1 };

  it('metanetOffered: a computer at the top level only', () => {
    expect(metanetOffered({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130'), window: top })).toBe(true);
    expect(metanetOffered({ navigator: nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148'), window: top })).toBe(false);
    expect(metanetOffered({ navigator: nav('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36'), window: top })).toBe(false);
    expect(metanetOffered({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5), window: top })).toBe(false); // iPad
    const framed = { self: 1, top: 2 };
    expect(metanetOffered({ navigator: nav('Mozilla/5.0 (Macintosh) Chrome/130'), window: framed })).toBe(false);
    const unreadable = { self: 1, get top(): unknown { throw new Error('cross-origin'); } };
    expect(inAnyFrame(unreadable)).toBe(true);
    expect(metanetOffered({ navigator: nav('Mozilla/5.0 (Macintosh) Chrome/130'), window: unreadable })).toBe(false);
  });

  it('on a phone: no link, no chooser row, no silent attempt, and connect({ metanet }) refuses', async () => {
    metanet = fakeMetanet();
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    rememberKnownIdentityKey(metanet.key);
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', maxTouchPoints: 5 });
    const el = mount({ metanet: 'on' });
    await tick(80);
    expect(metanetLink(el)).toBeNull();
    expect(notYouLink(el)).toBeNull();
    expect(await trySilentMetanet()).toEqual({ ok: false, stop: 'not-here' });
    void chooseWallet([]);
    expect(document.querySelector('[data-wallet=metanet]')).toBeNull();
    await expect(runConnect({ list: [], metanet: true, pick: noPick, post })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(localHits()).toEqual([]);
  });

  it('inside a frame: hidden too', async () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window & typeof globalThis);
    const el = mount({ metanet: 'on' });
    await tick(10);
    expect(metanetLink(el)).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('7. the minimum: no protocol permissions at connect, one request at a time', () => {
  const allowed = ['getVersion', 'isAuthenticated', 'getPublicKey', 'createSignature'];

  it('tapped sign-in: getVersion, isAuthenticated, the identity key, then the sign-in signature, in sequence', async () => {
    metanet = fakeMetanet();
    const el = mount();
    metanetLink(el)!.click();
    await until(() => el.state === 'signed-in');
    expect(metanet.methods()).toEqual(['getVersion', 'isAuthenticated', 'getPublicKey', 'createSignature']);
    expect(metanet.calls.find((c) => c.m === 'getPublicKey')!.args).toEqual({ identityKey: true });
    expect(metanet.calls.find((c) => c.m === 'createSignature')!.args.protocolID).toEqual(LOGIN_PROTOCOL);
    for (let i = 1; i < metanet.calls.length; i++) expect(metanet.calls[i]!.t).toBeGreaterThanOrEqual(metanet.calls[i - 1]!.done!);
  });

  it('connect without sign-in: the identity key only', async () => {
    metanet = fakeMetanet();
    const r = await runConnect({ list: [], metanet: true, pick: noPick, post });
    expect(r?.identityKey).toBe(metanet.key);
    expect(metanet.methods()).toEqual(['getVersion', 'isAuthenticated', 'getPublicKey']);
  });

  it('silent sign-in: the same calls, nothing else', async () => {
    metanet = fakeMetanet();
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    rememberKnownIdentityKey(metanet.key);
    const el = mount();
    await until(() => el.state === 'signed-in');
    expect(metanet.methods().every((m) => allowed.includes(m))).toBe(true);
    expect(metanet.methods().filter((m) => m === 'createSignature')).toHaveLength(1);
    expect(metanet.calls.filter((c) => c.m === 'getPublicKey').every((c) => JSON.stringify(c.args) === '{"identityKey":true}')).toBe(true);
  });
});

describe('8. no coins for the fee: one plain message', () => {
  const to = () => PrivateKey.fromRandom().toAddress();

  it('Metanet over the JSON API (WERR_INSUFFICIENT_FUNDS, code 7) → INSUFFICIENT_FUNDS with the plain line', async () => {
    metanet = fakeMetanet({ noCoins: true });
    const w = await connectMetanetDesktop();
    const e = await pay(w, { to: to(), sats: 1000 }).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentError);
    expect(e).toMatchObject({ code: 'INSUFFICIENT_FUNDS', message: NO_COINS_TEXT, maybeSent: false });
    expect(NO_COINS_TEXT).toBe("Your wallet doesn't have enough to cover this payment and its small network fee. Add a little and try again.");
  });

  it('any wallet\'s own "insufficient funds" text gets the same line; other errors are unchanged', async () => {
    const wallet = (err: unknown) => ({ createAction: async () => { throw err; } }) as unknown as WalletInterface;
    await expect(pay(wallet(new WERR_INSUFFICIENT_FUNDS(500, 400)), { to: to(), sats: 100 })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expect(pay(wallet(new Error('Not enough funds to cover the fee')), { to: to(), sats: 100 })).rejects.toMatchObject({ message: NO_COINS_TEXT });
    await expect(pay(wallet(new Error('broadcast failed')), { to: to(), sats: 100 })).rejects.toMatchObject({ code: 'WALLET_ERROR', maybeSent: true });
    await expect(pay(wallet(new Error('User denied')), { to: to(), sats: 100 })).rejects.toMatchObject({ code: 'WALLET_REJECTED' });
  });
});

describe('review fix 1: no desktop wallet on localhost is picked without its own tap', () => {
  const yoursOpt = () => brc100Option({} as WalletInterface, { id: 'io.yours', rdns: 'io.yours', name: 'Yours', substrate: 'injected' });
  const localOpt = () => brc100Option({} as WalletInterface, { id: 'localhost:3321', name: 'Desktop wallet (localhost:3321)', substrate: 'json-api' });

  it('autoChoice (fastPath={false}) never returns a localhost wallet; its presence means the picker', () => {
    expect(isLocalDesktop(localOpt())).toBe(true);
    expect(isLocalDesktop(desktopOption())).toBe(true);
    expect(isLocalDesktop(metanetOption())).toBe(true);
    expect(autoChoice([localOpt()])).toBeUndefined();
    expect(autoChoice([yoursOpt(), localOpt()])).toBeUndefined();
    expect(autoChoice([localOpt()], true)).toBeNull();
    expect(autoChoice([localOpt(), yoursOpt()], true)?.id).toBe('io.yours');
    expect(autoChoice([yoursOpt()])?.id).toBe('io.yours'); // the 0.5.5 rule otherwise unchanged
  });

  it('probeLocal + fastPath={false}: the tap opens the picker; Metanet is never connected or asked to sign', async () => {
    metanet = fakeMetanet();
    const list = await discoverWallets({ ms: 20, probeLocal: true });
    expect(list.some((o) => o.id === 'localhost:3321')).toBe(true);
    const pick = vi.fn(async () => null);
    expect(await runConnect({ list, fastPath: false, pick, challengeUrl: '/c', verifyUrl: '/v', post })).toBeNull();
    expect(pick).toHaveBeenCalledOnce();
    expect(metanet.methods()).not.toContain('getPublicKey');
    expect(metanet.methods()).not.toContain('createSignature');
    await expect(runConnect({ list, fastPath: false, picker: false, pick: noPick, post })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(metanet.methods()).not.toContain('getPublicKey');
  });

  it('probeLocal + a remembered "desktop" (fast path): the chooser, not Metanet', async () => {
    metanet = fakeMetanet();
    const list = await discoverWallets({ ms: 20, probeLocal: true });
    const remembered = { type: 'desktop', substrate: 'json-api' as const };
    expect(decideWallet(list, { remembered }).reason).toBe('chooser');
    const pick = vi.fn(async () => null);
    expect(await runConnect({ list, remembered, pick, challengeUrl: '/c', verifyUrl: '/v', post })).toBeNull();
    expect(pick).toHaveBeenCalledOnce();
    expect(metanet.methods()).not.toContain('createSignature');
    expect(planAutoConnect({ remembered, signedIn: false }).action).toBe('none');
  });
});

describe('review fix 2: a key is "known" only after a verified sign-in (or a session match)', () => {
  it('runConnect: a plain connect remembers the type but adds no known key; a verified sign-in adds it', async () => {
    metanet = fakeMetanet();
    const plain = await runConnect({ list: [], metanet: true, remember: true, pick: noPick, post });
    expect(plain).toMatchObject({ signedIn: false, identityKey: metanet.key });
    expect(rememberedWalletChoice()).toEqual(META_KEY);
    expect(knownIdentityKeys()).toEqual([]);
    await runConnect({ list: [], metanet: true, remember: true, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post });
    expect(knownIdentityKeys()).toEqual([metanet.key]);
  });

  it('the element without verify-url (nothing proved to a server) adds no known key', async () => {
    metanet = fakeMetanet();
    const el = mount();
    el.removeAttribute('verify-url');
    metanetLink(el)!.click();
    await until(() => el.state === 'signed-in');
    expect(knownIdentityKeys()).toEqual([]);
  });

  it('runSilentMetanet with a session for another key attaches nothing and records nothing', async () => {
    metanet = fakeMetanet();
    localStorage.setItem(WALLET_CHOICE_KEY, JSON.stringify({ ...META_KEY, v: 1 }));
    localStorage.setItem('bwx:identityKey', metanet.key); // known as the last sign-in's key
    expect(await runSilentMetanet({ sessionKey: PrivateKey.fromRandom().toPublicKey().toString() })).toBeNull();
    expect(knownIdentityKeys()).toEqual([]);
  });
});

describe('review fix 3: logout-url is required with verify-url', () => {
  it('warns once in development when it is missing; not when it is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetLogoutWarning();
    mount({ 'logout-url': '/out' });
    expect(warn).not.toHaveBeenCalled();
    mount();
    mount();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('logout URL');
    resetLogoutWarning();
    expect(warnIfNoLogout({ verifyUrl: '/v', logoutUrl: '/out', where: 'x' })).toBe(false);
    warn.mockRestore();
  });
});
