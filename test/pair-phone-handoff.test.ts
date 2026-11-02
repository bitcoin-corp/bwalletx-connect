import { PrivateKey } from '@bsv/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pairBwalletX, type PageLifecycle } from '../src/pair';
import { FakeRelay } from './fake-relay';
import { fakePhone } from './phone';

/**
 * "Open in bWalletX" on the same phone (@photokuro, Jon, 2 Nov 2026): the browser goes to the background while the
 * user taps Connect in the app, and iOS may kill the page's relay socket. Pairing must survive that.
 */
const ORIGIN = 'https://example.com';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakePage(): PageLifecycle & { show(): void; hide(): void } {
  let vis = true;
  const cbs = new Set<() => void>();
  return {
    visible: () => vis,
    onVisible: (cb) => (cbs.add(cb), () => void cbs.delete(cb)),
    hide: () => void (vis = false),
    show: () => {
      vis = true;
      cbs.forEach((cb) => cb());
    },
  };
}

const siteSocket = (relay: FakeRelay, link: string) => relay.channels.get(new URL(link).searchParams.get('c')!)?.site;

afterEach(() => vi.useRealTimers());

describe('pairing across a trip to the bWalletX app', () => {
  it('the socket dies while the page is in the background; back on the page it rejoins and gets the queued hello + ready', async () => {
    const relay = new FakeRelay(ORIGIN, { queue: true });
    const page = fakePage();
    const root = PrivateKey.fromRandom();
    let link = '';
    let code = '';
    let paired = 0;
    const p = pairBwalletX({ origin: ORIGIN, storage: null, socket: relay.socket, page, onLink: (l) => (link = l), onCode: (c) => (code = c), onPaired: () => paired++ });
    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    await tick(10);
    // Tap "Open in bWalletX": Safari goes to the background and iOS closes the socket.
    page.hide();
    siteSocket(relay, link)!.close();
    // The user approves in the app; its frames wait at the relay.
    const phone = fakePhone(link, relay.socket, root, { burst: true });
    await tick(50);
    expect(settled).toBe(false);
    expect(code).toBe('');
    // Back to the browser.
    page.show();
    const wallet = await p;
    expect(code).toBe(phone.code);
    expect(paired).toBe(1);
    const sites = relay.urls.filter((u) => u.includes('role=site'));
    expect(sites).toHaveLength(2);
    expect(new URL(sites[1]).searchParams.get('claim')).toBe(new URL(sites[0]).searchParams.get('claim'));
    const { publicKey } = await wallet.getPublicKey({ identityKey: true });
    expect(publicKey).toBe(root.toPublicKey().toString());
  });

  it('a blip while the page is visible rejoins by itself', async () => {
    const relay = new FakeRelay(ORIGIN, { queue: true });
    const root = PrivateKey.fromRandom();
    let link = '';
    const p = pairBwalletX({ origin: ORIGIN, storage: null, socket: relay.socket, page: fakePage(), onLink: (l) => (link = l), onCode: () => {} });
    await tick(10);
    siteSocket(relay, link)!.close();
    fakePhone(link, relay.socket, root, { burst: true });
    const wallet = await p;
    expect((await wallet.getPublicKey({ identityKey: true })).publicKey).toBe(root.toPublicKey().toString());
  });

  it('a page that wakes after the deadline still finishes when the ready is waiting at the relay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const relay = new FakeRelay(ORIGIN, { queue: true });
    const page = fakePage();
    const root = PrivateKey.fromRandom();
    let link = '';
    const p = pairBwalletX({ origin: ORIGIN, storage: null, socket: relay.socket, page, lifetimeS: 30, onLink: (l) => (link = l), onCode: () => {} });
    let outcome = '';
    void p.then(() => (outcome = 'paired'), (e: Error) => (outcome = e.message));
    await vi.waitFor(() => expect(link).not.toBe(''), { interval: 5 });
    await vi.advanceTimersByTimeAsync(10);
    page.hide();
    siteSocket(relay, link)!.close();
    fakePhone(link, relay.socket, root, { burst: true });
    await vi.waitFor(() => expect(relay.queued.size).toBeGreaterThan(0), { interval: 5 });
    // Away for well past the 30 s window: the timer fires while hidden and must not give up.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(outcome).toBe('');
    page.show();
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await vi.waitFor(() => expect(outcome).toBe('paired'), { interval: 5 });
  });

  it('with no wallet the round expires; retry starts a fresh link, and false gives up with EXPIRED', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const relay = new FakeRelay(ORIGIN, { queue: true });
    const links: string[] = [];
    const errors: string[] = [];
    const p = pairBwalletX({
      origin: ORIGIN,
      storage: null,
      socket: relay.socket,
      page: fakePage(),
      lifetimeS: 30,
      onLink: (l) => links.push(l),
      onCode: () => {},
      retry: async (e) => (errors.push(e.message), errors.length < 2),
    });
    let err: (Error & { code?: string }) | null = null;
    void p.catch((e) => (err = e));
    for (let i = 0; i < 4 && !err; i++) await vi.advanceTimersByTimeAsync(40_000);
    expect(errors).toEqual(['The pairing code expired. Show a new one.', 'The pairing code expired. Show a new one.']);
    expect(links).toHaveLength(2);
    expect(new URL(links[1]).searchParams.get('c')).not.toBe(new URL(links[0]).searchParams.get('c'));
    expect(err!.code).toBe('EXPIRED');
  });

  it('the relay never answering is still "unreachable", with no rejoin loop', async () => {
    const page = fakePage();
    const sock = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null as null | ((e: unknown) => void),
      onclose: null as null | ((e: unknown) => void),
      send() {},
      close() {},
    };
    let made = 0;
    const p = pairBwalletX({ origin: ORIGIN, storage: null, page, socket: () => (made++, sock), onLink: () => {}, onCode: () => {} });
    await tick(10);
    sock.onerror?.({});
    sock.onclose?.({});
    await expect(p).rejects.toThrow('Could not reach the bWalletX pairing service');
    expect(made).toBe(1);
  });
});
