// @vitest-environment happy-dom
/**
 * 0.5.6 wallet choice (RB, 5 Nov 2026):
 *   - bWalletX is recognised by its own announcement, never by who holds window.CWI;
 *   - bWalletX here → straight to its sheet, no chooser; "Other wallets" opens the chooser;
 *   - no bWalletX → the chooser, "Get bWalletX" first; another wallet only when picked;
 *   - nothing touches localhost before "Desktop wallet" is tapped;
 *   - one telemetry record per attempt: { walletType, substrate, outcome, ms } and nothing else.
 */
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBwalletX } from '../src/discover';
import { brc100Option, discoverWallets, pairingOption, type WalletOption } from '../src/wallets';
import { decideWallet, hasBwalletX, isPresentBwalletX, type ConnectAttempt } from '../src/choice';
import { chooseWallet } from '../src/modal';
import { runConnect } from '../src/connect-flow';
import { defineBwalletxSignin } from '../src/element';
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

/** A ProtoWallet that logs its calls. */
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
/** A wallet that answers brc100:requestWallet with `rdns`. */
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
const site = () => {
  const post = async (url: string, body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (url === '/c') return (await createChallenge({ origin: ORIGIN, identityKey: b.identityKey as string | undefined, store })) as unknown as Record<string, unknown>;
    const k = await verifySignIn({ origin: ORIGIN, store, ...(b as { identityKey: string; nonce: string; signature: number[] }) });
    if (!k) throw Object.assign(new Error('sign-in failed'), { status: 401 });
    return { identityKey: k };
  };
  return { post };
};

/** Every request the page makes, so a localhost probe can't hide. */
let requests: string[] = [];
beforeEach(() => {
  requests = [];
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      requests.push(String(url));
      throw new TypeError('network off in tests');
    }),
  );
});
afterEach(() => {
  while (stops.length) stops.pop()!();
  delete g.CWI;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
const localHits = () => requests.filter((u) => /localhost|127\.0\.0\.1/.test(u));

describe('detection: bWalletX by its own announcement only', () => {
  it('bWalletX announced → found at once, listed first, chosen with no chooser', async () => {
    const b = bwalletx();
    const f = await discoverBwalletX(1000);
    expect(f?.method).toBe('extension');
    expect(f?.wallet).toBe(b.wallet);
    const list = await discoverWallets({ ms: 20 });
    expect(list.map((o) => [o.id, o.substrate])).toEqual([['com.bwalletx.extension', 'extension']]);
    expect(decideWallet(list)).toMatchObject({ reason: 'bwalletx', option: list[0] });
  });

  it('window.CWI overwritten by another wallet while bWalletX is present → still bWalletX, the other is just listed', async () => {
    const b = bwalletx();
    const metanet = fakeWallet();
    g.CWI = metanet.wallet; // e.g. BSV Desktop's page script ran after ours
    const f = await discoverBwalletX(50);
    expect(f?.wallet).toBe(b.wallet);
    expect(f?.wallet).not.toBe(metanet.wallet);
    const list = await discoverWallets({ ms: 20 });
    expect(list.map((o) => [o.id, o.isBwalletX, o.substrate])).toEqual([
      ['com.bwalletx.extension', true, 'extension'],
      ['window.CWI', false, 'window.CWI'],
    ]);
    const d = decideWallet(list);
    expect(d.reason).toBe('bwalletx');
    expect(d.option?.wallet).toBe(b.wallet);
    expect(metanet.calls).toEqual([]);
  });

  it('a window.CWI marked as bWalletX by the app is still not "present" unless it came from an announcement', () => {
    const cwi = brc100Option(fakeWallet().wallet, { id: 'window.CWI', name: 'bWalletX?', isBwalletX: true, substrate: 'window.CWI' });
    expect(isPresentBwalletX(cwi)).toBe(false);
    expect(decideWallet([cwi]).reason).toBe('chooser');
  });

  it('only Yours → no bWalletX; the chooser, never Yours unasked (picker off → nothing)', async () => {
    const y = yours();
    g.CWI = y.wallet;
    expect(await discoverBwalletX(30)).toBeNull();
    const list = await discoverWallets({ ms: 20 });
    expect(list.map((o) => o.id)).toEqual(['io.yours']); // window.CWI is the wallet Yours announced: listed once
    expect(hasBwalletX(list)).toBe(false);
    expect(decideWallet(list)).toEqual({ option: null, reason: 'chooser' });
    expect(decideWallet(list, { picker: false })).toEqual({ option: null, reason: 'none' });
    expect(y.calls).toEqual([]);
  });

  it('nothing at all → none; with phone pairing → the chooser (picker off → the phone)', async () => {
    expect(await discoverBwalletX(30)).toBeNull();
    const list = await discoverWallets({ ms: 20 });
    expect(list).toEqual([]);
    expect(decideWallet(list).reason).toBe('none');
    const phone = pairingOption({ onLink: () => undefined, onCode: () => undefined });
    expect(decideWallet([phone]).reason).toBe('chooser');
    expect(decideWallet([phone], { picker: false })).toEqual({ option: phone, reason: 'bwalletx-phone' });
  });

  it('fastPath: false keeps the 0.5.5 rule (one wallet of any brand, no picker)', () => {
    const y = brc100Option(fakeWallet().wallet, { id: 'io.yours', name: 'Yours', rdns: 'io.yours' });
    expect(decideWallet([y], { fastPath: false })).toEqual({ option: y, reason: 'legacy' });
    expect(decideWallet([y])).toEqual({ option: null, reason: 'chooser' });
  });
});

describe('fast path (BwalletXProvider.connect / runConnect)', () => {
  it('bWalletX + Yours + phone: straight to bWalletX, one sheet, no chooser', async () => {
    const b = bwalletx();
    const y = yours();
    const list = await discoverWallets({ ms: 20, pairing: { onLink: () => undefined, onCode: () => undefined } });
    expect(list.map((o) => o.id)).toEqual(['com.bwalletx.extension', 'bwalletx-pairing', 'io.yours']);
    const r = await runConnect({ list, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post: site().post });
    expect(r).toMatchObject({ signedIn: true, identityKey: b.key, walletType: 'bwalletx', substrate: 'extension', reason: 'bwalletx' });
    expect(b.calls.filter((c) => c !== 'isAuthenticated')).toEqual(['getPublicKey', 'createSignature']);
    expect(y.calls).toEqual([]);
  });

  it('"Other wallets" (chooser: true) opens the chooser even with bWalletX here, and the pick is used', async () => {
    bwalletx();
    const y = yours();
    const list = await discoverWallets({ ms: 20 });
    const pick = vi.fn(async (l: WalletOption[]) => l.find((o) => o.id === 'io.yours')!);
    const r = await runConnect({ list, chooser: true, pick, challengeUrl: '/c', verifyUrl: '/v', post: site().post });
    expect(pick).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ signedIn: true, identityKey: y.key, walletType: 'io.yours', substrate: 'injected', reason: 'chooser' });
  });

  it('no bWalletX: the chooser opens; closing it connects nothing', async () => {
    const y = yours();
    const list = await discoverWallets({ ms: 20 });
    const pick = vi.fn(async () => null);
    expect(await runConnect({ list, pick, post: site().post })).toBeNull();
    expect(pick).toHaveBeenCalledOnce();
    expect(y.calls).toEqual([]);
  });

  it('picker off and no bWalletX: NOT_FOUND, never another wallet', async () => {
    const y = yours();
    const list = await discoverWallets({ ms: 20 });
    await expect(runConnect({ list, picker: false, pick: noPick, post: site().post })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(y.calls).toEqual([]);
  });
});

describe('first sign-in = one wallet sheet (vexvoid, 5 Nov: two bundles on 0.5.4)', () => {
  it('connect({ walletId }) sends the identity key and the signature inside one 60 ms merge window', async () => {
    // 0.5.4 asked getPublicKey in connect(), waited for the approval, then signed: bundle 1, then bundle 2 ~1 s later.
    const root = PrivateKey.fromRandom();
    const pw = new ProtoWallet(root);
    const asked: { m: string; t: number }[] = [];
    const sheet = async <T>(m: string, run: () => Promise<T>) => {
      asked.push({ m, t: Date.now() });
      await tick(150); // the sheet is up until the user taps
      return run();
    };
    const wallet = {
      isAuthenticated: async () => ({ authenticated: true }),
      getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => sheet('getPublicKey', () => pw.getPublicKey(a)),
      createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => sheet('createSignature', () => pw.createSignature(a)),
    } as unknown as WalletInterface;
    const ext = brc100Option(wallet, { id: 'com.bwalletx.extension', rdns: 'com.bwalletx.extension', name: 'bWalletX', isBwalletX: true, substrate: 'extension' });
    const r = await runConnect({ list: [ext], walletId: ext.id, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post: site().post });
    expect(r?.signedIn).toBe(true);
    expect(asked.map((a) => a.m).sort()).toEqual(['createSignature', 'getPublicKey']);
    expect(Math.abs(asked[0].t - asked[1].t)).toBeLessThan(60);
  });
});

describe('the chooser', () => {
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-bwx-chooser] [data-wallet]')).map((e) => e.dataset.wallet);

  it('without bWalletX: "Get bWalletX" first, then the detected wallets and Desktop', async () => {
    yours();
    const list = await discoverWallets({ ms: 20, pairing: { onLink: () => undefined, onCode: () => undefined } });
    const p = chooseWallet(list);
    expect(rows()).toEqual(['get-bwalletx', 'bwalletx-pairing', 'io.yours', 'metanet']); // 0.7.0: the Metanet row replaces "Desktop wallet"
    const get = document.querySelector<HTMLAnchorElement>('[data-wallet=get-bwalletx]')!;
    expect(get.tagName).toBe('A');
    expect(get.href).toBe('https://bwalletx.com/get');
    expect(document.body.textContent).toContain('Some features need bWalletX.');
    document.querySelector<HTMLElement>('[data-wallet="io.yours"]')!.click();
    expect((await p)?.id).toBe('io.yours');
  });

  it('with bWalletX ("Other wallets"): bWalletX is the first, gold row; no Get row', async () => {
    bwalletx();
    yours();
    const list = await discoverWallets({ ms: 20 });
    const p = chooseWallet(list, { desktop: false });
    expect(rows()).toEqual(['com.bwalletx.extension', 'io.yours']);
    expect(document.querySelector('[data-wallet="com.bwalletx.extension"]')!.className).toContain('bwx-primary');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toBeNull();
    expect(document.querySelector('[data-bwx-chooser]')).toBeNull();
  });
});

describe('no localhost probe before a tap', () => {
  it('listing, deciding and opening the chooser never touch localhost; tapping "Desktop wallet" does', async () => {
    yours();
    const list = await discoverWallets({ ms: 20, pairing: { onLink: () => undefined, onCode: () => undefined } });
    decideWallet(list);
    const p = chooseWallet(list);
    await tick(20);
    expect(localHits()).toEqual([]);
    document.querySelector<HTMLElement>('[data-wallet=metanet]')!.click(); // 0.7.0: was "Desktop wallet"
    const desktop = (await p)!;
    expect(localHits()).toEqual([]); // picking it still asks nothing: connect() looks
    await expect(desktop.connect()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(localHits().some((u) => u.includes('localhost:3321'))).toBe(true);
  });

  it('the provider default (probeLocal off) never probes while listing', async () => {
    await discoverWallets({ ms: 20 });
    await tick(20);
    expect(localHits()).toEqual([]);
  });
});

describe('telemetry: one record per attempt, nothing identifying', () => {
  it('reports walletType, substrate, outcome and ms only', async () => {
    const b = bwalletx();
    const seen: ConnectAttempt[] = [];
    const list = await discoverWallets({ ms: 20 });
    await runConnect({ list, pick: noPick, challengeUrl: '/c', verifyUrl: '/v', post: site().post, onAttempt: (a) => seen.push(a) });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual(['ms', 'outcome', 'substrate', 'walletType']);
    expect(seen[0]).toMatchObject({ walletType: 'bwalletx', substrate: 'extension', outcome: 'signed-in' });
    expect(seen[0].ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(seen)).not.toContain(b.key);
    expect(JSON.stringify(seen)).not.toMatch(/0[23][0-9a-f]{64}/);
  });

  it('cancelled, not-found and rejected; a throwing hook never breaks sign-in', async () => {
    const seen: ConnectAttempt[] = [];
    const onAttempt = (a: ConnectAttempt) => seen.push(a);
    const y = brc100Option(fakeWallet().wallet, { id: 'io.yours', rdns: 'io.yours', name: 'Yours', substrate: 'injected' });
    await runConnect({ list: [y], pick: async () => null, post: site().post, onAttempt });
    await runConnect({ list: [], pick: noPick, post: site().post, onAttempt }).catch(() => undefined);
    const no = brc100Option(
      { getPublicKey: async () => { throw Object.assign(new Error('The user denied the request.'), { code: 'ERR_PERMISSION_DENIED' }); } } as unknown as WalletInterface,
      { id: 'com.bwalletx.extension', rdns: 'com.bwalletx.extension', name: 'bWalletX', isBwalletX: true, substrate: 'extension' },
    );
    await runConnect({ list: [no], pick: noPick, post: site().post, onAttempt }).catch(() => undefined);
    expect(seen.map((a) => [a.walletType, a.substrate, a.outcome])).toEqual([
      [null, null, 'cancelled'],
      [null, null, 'not-found'],
      ['bwalletx', 'extension', 'rejected'],
    ]);
    const b = brc100Option(fakeWallet().wallet, { id: 'com.bwalletx.extension', name: 'bWalletX', isBwalletX: true, substrate: 'extension' });
    const r = await runConnect({ list: [b], pick: noPick, post: site().post, onAttempt: () => { throw new Error('metrics down'); } });
    expect(r?.identityKey).toMatch(/^0[23]/);
  });
});

describe('<bwalletx-signin>: fast path, chooser, "Other wallets"', () => {
  type El = HTMLElement & { button: HTMLButtonElement; state: string; otherWallets(): Promise<void> };
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
  /** Site routes; everything else (localhost included) is logged and fails. */
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
        throw new TypeError('network off');
      }),
    );

  it('bWalletX here: one tap → its sheet, no chooser, signed in; attempt event fired', async () => {
    routes();
    const b = bwalletx();
    yours();
    const el = mount({ 'challenge-url': '/c', 'verify-url': '/v', 'lookup-url': 'off' });
    const attempts: ConnectAttempt[] = [];
    el.addEventListener('bwalletx-attempt', (e) => attempts.push((e as CustomEvent<ConnectAttempt>).detail));
    expect(q(el, '.ow')?.textContent).toBe('Other wallets');
    el.button.click();
    await until(() => el.state === 'signed-in');
    expect(document.querySelector('[data-bwx-chooser]')).toBeNull();
    expect(b.calls).toContain('createSignature');
    expect(attempts).toEqual([expect.objectContaining({ walletType: 'bwalletx', substrate: 'extension', outcome: 'signed-in' })]);
    expect(localHits()).toEqual([]);
  });

  it('only Yours: the tap opens the chooser ("Get bWalletX" first); Yours is not asked anything', async () => {
    routes();
    const y = yours();
    const el = mount({ 'challenge-url': '/c', 'verify-url': '/v' });
    el.button.click();
    await until(() => !!document.querySelector('[data-bwx-chooser]'));
    const first = document.querySelector<HTMLElement>('[data-bwx-chooser] [data-wallet]')!;
    expect(first.dataset.wallet).toBe('get-bwalletx');
    expect(y.calls).toEqual([]);
    document.querySelector<HTMLElement>('[data-wallet="io.yours"]')!.click();
    await until(() => el.state === 'signed-in');
    expect(y.calls).toContain('createSignature');
    expect(el.button.getAttribute('aria-label')).toContain('Signed in');
  });

  it('nothing here: the not-found row, with "Other wallets"', async () => {
    routes();
    const el = mount({ 'challenge-url': '/c', 'discover-ms': '30' });
    el.button.click();
    await until(() => !!q(el, '.nf'));
    expect(q(el, '.nf')!.textContent).toContain('Other wallets');
    expect(document.querySelector('[data-bwx-chooser]')).toBeNull();
    q(el, '.nf [data-act=other]')!.click();
    await until(() => !!document.querySelector('[data-bwx-chooser]'));
    expect(localHits()).toEqual([]);
  });

  it('"Other wallets" link: lg/md only by default, "on"/"off" override, opens the chooser with bWalletX here', async () => {
    routes();
    bwalletx();
    expect(q(mount({ 'challenge-url': '/c', size: 'sm' }), '.ow')).toBeNull();
    expect(q(mount({ 'challenge-url': '/c', size: 'sm', 'other-wallets': 'on' }), '.ow')).not.toBeNull();
    expect(q(mount({ 'challenge-url': '/c', 'other-wallets': 'off' }), '.ow')).toBeNull();
    expect(q(mount({}), '.ow')).toBeNull(); // event-only / link mode: nothing to choose
    const el = mount({ 'challenge-url': '/c', 'verify-url': '/v' });
    q(el, '.ow button')!.click();
    await until(() => !!document.querySelector('[data-bwx-chooser]'));
    expect(document.querySelector<HTMLElement>('[data-bwx-chooser] [data-wallet]')!.dataset.wallet).toBe('com.bwalletx.extension');
  });
});
