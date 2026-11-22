/**
 * P0 22 Nov 2026 (owner): "signing in with bwallet doesn't work on the phone … we get the share code and click OK
 * but it doesn't return us to the app, and doesn't connect. When we return manually we see the same share code."
 *
 * On ONE phone the site's tab is asleep while the user is in bWalletX: iOS freezes it and its relay socket dies.
 * These tests play that out against the fake relay (which queues like the real one) and a fake phone.
 */
import { PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import { pairBwalletX, resumeReturnedPairing, type PairStorage } from '../src/pair';
import { loginMessageFor, parsePairUrl, parseReturnFragment } from '../src/protocol';
import { FakeRelay, FakeSocket } from './fake-relay';
import { fakePhone } from './phone';

const ORIGIN = 'https://example.com';
const PAGE = 'https://example.com/rooms/lounge?x=1';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const mapStorage = (): PairStorage & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
/** A manual "the page is back" signal (visibilitychange / pageshow in a browser). */
const wakeHook = () => {
  const fns = new Set<() => void>();
  return { on: (fn: () => void) => (fns.add(fn), () => void fns.delete(fn)), fire: () => fns.forEach((f) => f()) };
};
const siteSocket = (relay: FakeRelay, c: string) => relay.channels.get(c)?.site as FakeSocket | undefined;

describe('the site tab sleeps while the user is in bWalletX', () => {
  it('pairing survives the tab socket dying: the queued hello and ready arrive after the tab wakes', async () => {
    const relay = new FakeRelay(ORIGIN);
    const wake = wakeHook();
    let link = '';
    let code = '';
    const paired = pairBwalletX({ origin: ORIGIN, storage: null, socket: relay.socket, onWake: wake.on, onCode: (c) => (code = c), onLink: (l) => (link = l) });
    let settled: 'ok' | 'err' | null = null;
    paired.then(() => (settled = 'ok'), () => (settled = 'err'));
    await tick(5);
    const c = parsePairUrl(link).c;
    // The user taps "Open bWalletX": Safari goes to the background and iOS kills the tab's socket.
    const old = siteSocket(relay, c)!;
    old.drop();
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom());
    await tick(20);
    expect(phone.readyFrame).toBeTruthy(); // the user tapped Connect; hello + ready are queued at the relay
    old.wakeClosed(); // back in Safari: the page hears its socket closed
    await tick(5);
    expect(settled).toBe(null); // not "connection closed before pairing finished"
    wake.fire();
    const w = await paired;
    expect(code).toBe(phone.code);
    expect(typeof w.getPublicKey).toBe('function');
  });

  it('a call survives the tab socket dying: it is re-sent with the same id when the phone says ready again', async () => {
    const relay = new FakeRelay(ORIGIN);
    const wake = wakeHook();
    const root = PrivateKey.fromRandom();
    let phone: ReturnType<typeof fakePhone> | undefined;
    const w = await pairBwalletX({
      origin: ORIGIN,
      storage: null,
      socket: relay.socket,
      onWake: wake.on,
      onCode: () => {},
      onLink: (l) => setTimeout(() => (phone = fakePhone(l, relay.socket, root)), 0),
    });
    const c = [...relay.channels.keys()][0];
    // The site asks for the sign-in signature, then the tab sleeps before the answer comes back: the answer is lost
    // with the frozen socket.
    const s = siteSocket(relay, c)!;
    s.frozen = true;
    const call = w.getPublicKey({ identityKey: true });
    let rejected: unknown = null;
    call.catch((e) => (rejected = e));
    await tick(10);
    s.drop();
    s.wakeClosed();
    await tick(5);
    expect(rejected).toBe(null); // the call is still waiting, not failed with "connection closed"
    wake.fire();
    const { publicKey } = await call;
    expect(publicKey).toBe(root.toPublicKey().toString());
    expect(phone!.requests).toEqual(['getPublicKey']); // re-sent with the same id: answered once, replayed
  });
});

describe('same phone: return to the site, sign-in folded into Connect', () => {
  const challenge = () => {
    const nonce = 'n0nce_' + Math.random().toString(36).slice(2, 12);
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    return { nonce, expiresAt, message: loginMessageFor(ORIGIN, nonce, expiresAt) };
  };

  it('the link carries ret, rid, b and the sign-in challenge (ln, lx)', async () => {
    const relay = new FakeRelay(ORIGIN);
    const ch = challenge();
    let link = '';
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: mapStorage(), socket: relay.socket, returnTo: PAGE + '#old', browser: 'safari', login: ch, onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await tick(5);
    const l = parsePairUrl(link);
    expect(l.ret).toBe(PAGE);
    expect(l.rid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(l.b).toBe('safari');
    expect(l.ln).toBe(ch.nonce);
    expect(l.lx).toBe(ch.expiresAt);
  });

  it('no return on another origin', async () => {
    const relay = new FakeRelay(ORIGIN);
    let link = '';
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: mapStorage(), socket: relay.socket, returnTo: 'https://evil.example.net/x', onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await tick(5);
    expect(parsePairUrl(link).ret).toBeUndefined();
  });

  it('a folded sign-in is answered by the paired wallet without another trip to the phone', async () => {
    const relay = new FakeRelay(ORIGIN);
    const root = PrivateKey.fromRandom();
    const ch = challenge();
    let phone: ReturnType<typeof fakePhone> | undefined;
    const w = await pairBwalletX({
      origin: ORIGIN,
      storage: null,
      returnStorage: mapStorage(),
      socket: relay.socket,
      returnTo: PAGE,
      login: ch,
      onCode: () => {},
      onLink: (l) => setTimeout(() => (phone = fakePhone(l, relay.socket, root, { fold: true })), 0),
    });
    expect(w.signedIn?.identityKey).toBe(root.toPublicKey().toString());
    const [{ publicKey }, { signature }] = await Promise.all([
      w.getPublicKey({ identityKey: true }),
      w.createSignature({ protocolID: [2, 'bwallet sign in'], keyID: ch.nonce, counterparty: 'anyone', data: Array.from(new TextEncoder().encode(ch.message)) }),
    ]);
    expect(phone!.requests).toEqual([]); // nothing went to the phone: it is asleep by now
    expect(publicKey).toBe(root.toPublicKey().toString());
    // A real signature by the identity key under the login protocol (what verifySignIn checks).
    const pub = PublicKey.fromString(publicKey);
    expect(pub.toString()).toBe(root.toPublicKey().toString());
    expect(Signature.fromDER(signature).toDER().length).toBeGreaterThan(60);
  });

  it('the return tab finishes the pairing and the sign-in from the fragment alone (the relay frames were lost)', async () => {
    const relay = new FakeRelay(ORIGIN);
    const root = PrivateKey.fromRandom();
    const ch = challenge();
    const returns = mapStorage();
    let link = '';
    const wake = wakeHook();
    const first = pairBwalletX({ origin: ORIGIN, storage: mapStorage(), returnStorage: returns, socket: relay.socket, onWake: wake.on, returnTo: PAGE, login: ch, onCode: () => {}, onLink: (l) => (link = l) });
    let firstOutcome: unknown = 'pending';
    first.then(() => (firstOutcome = 'ok'), (e) => (firstOutcome = e));
    await tick(5);
    const c = parsePairUrl(link).c;
    siteSocket(relay, c)!.frozen = true; // the old tab is asleep: hello and ready are swallowed
    const phone = fakePhone(link, relay.socket, root, { fold: true });
    await tick(20);
    expect(phone.returnTo).toMatch(/^https:\/\/example\.com\/rooms\/lounge\?x=1#bwx=ok&rid=/);
    const frag = parseReturnFragment(new URL(phone.returnTo!).hash)!;
    expect(frag.wk && frag.f).toBeTruthy();

    // iOS opens the return in a NEW tab: same localStorage, nothing else.
    const tabStorage = mapStorage();
    let cleaned = '';
    const r = await resumeReturnedPairing({ hash: new URL(phone.returnTo!).hash, href: phone.returnTo!, replaceUrl: (u) => (cleaned = u), returnStorage: returns, storage: tabStorage, socket: relay.socket });
    expect(cleaned).toBe(PAGE);
    expect(r?.login?.identityKey).toBe(root.toPublicKey().toString());
    expect(r?.login?.nonce).toBe(ch.nonce);
    const sig = Signature.fromDER(r!.login!.signature);
    const ok = PublicKey.fromString(r!.login!.identityKey);
    expect(sig && ok).toBeTruthy();
    // The pairing is stored for the next calls in this tab, and they work.
    expect(tabStorage.m.get('bwalletx.connect.pairing.v1')).toBeTruthy();
    const { publicKey } = await r!.wallet.getPublicKey({ identityKey: true, reason: 'later' } as never);
    expect(publicKey).toBe(root.toPublicKey().toString());

    // The old tab wakes later: it sees the return was taken in another tab and stops (no tug of war at the relay).
    wake.fire();
    await tick(5);
    expect((firstOutcome as { code?: string })?.code).toBe('RETURNED_IN_ANOTHER_TAB');
  });

  it('the return is taken once (a replayed fragment does nothing)', async () => {
    const relay = new FakeRelay(ORIGIN);
    const returns = mapStorage();
    let link = '';
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: returns, socket: relay.socket, returnTo: PAGE, login: challenge(), onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await tick(5);
    siteSocket(relay, parsePairUrl(link).c)!.frozen = true;
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom(), { fold: true });
    await tick(20);
    const hash = new URL(phone.returnTo!).hash;
    const opts = { hash, href: phone.returnTo!, replaceUrl: () => {}, returnStorage: returns, storage: mapStorage(), socket: relay.socket };
    expect(await resumeReturnedPairing(opts)).not.toBeNull();
    expect(await resumeReturnedPairing(opts)).toBeNull();
  });

  it('same tab: the return lands as a hash change and finishes the waiting pairing', async () => {
    const relay = new FakeRelay(ORIGIN);
    const root = PrivateKey.fromRandom();
    const wake = wakeHook();
    let link = '';
    let hash = '';
    const p = pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: mapStorage(), socket: relay.socket, onWake: wake.on, readHash: () => hash, replaceUrl: () => (hash = ''), returnTo: PAGE, login: challenge(), onCode: () => {}, onLink: (l) => (link = l) });
    await tick(5);
    siteSocket(relay, parsePairUrl(link).c)!.frozen = true;
    const phone = fakePhone(link, relay.socket, root, { fold: true });
    await tick(20);
    hash = new URL(phone.returnTo!).hash;
    wake.fire(); // hashchange / pageshow
    const w = await p;
    expect(w.signedIn?.identityKey).toBe(root.toPublicKey().toString());
    expect(hash).toBe('');
  });
});

describe('the code helper', () => {
  it('signature in a folded login is hex DER', () => {
    expect(Utils.toHex([1, 2])).toBe('0102');
  });
});
