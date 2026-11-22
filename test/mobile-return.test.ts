/**
 * P0 22 Nov 2026 (owner): "signing in with bwallet doesn't work on the phone … we get the share code and click OK
 * but it doesn't return us to the app, and doesn't connect. When we return manually we see the same share code."
 *
 * On ONE phone the site's tab is asleep while the user is in bWalletX: iOS freezes it and its relay socket dies.
 * These tests play that out against the fake relay (which queues like the real one) and a fake phone.
 */
import { PrivateKey, ProtoWallet, PublicKey, Signature, Utils } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import { pairBwalletX, resumeReturnedPairing, type PairStorage, type PairedWallet } from '../src/pair';
import { signPairProofs } from '../src/server';
import { Sealer, deriveSession, loginMessageFor, parsePairUrl, parseReturnFragment, returnFragment } from '../src/protocol';
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
    const returns = mapStorage();
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: returns, socket: relay.socket, returnTo: PAGE + '&code=SECRET#old', browser: 'safari', login: ch, onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await tick(5);
    const l = parsePairUrl(link);
    // Review 22 Nov (4, 6): the wallet gets the origin's root only; the page (no query, no fragment) stays here.
    expect(l.ret).toBe(`${ORIGIN}/`);
    expect(link).not.toContain('SECRET');
    expect(link).not.toContain('lounge');
    const saved = [...returns.m.values()].map((v) => JSON.parse(v) as { page?: string });
    expect(saved[0].page).toBe(`${ORIGIN}/rooms/lounge`);
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

  it('the return tab finishes the pairing and the sign-in once the relay confirms the fragment (the first frames were lost)', async () => {
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
    expect(phone.returnTo).toMatch(/^https:\/\/example\.com\/#bwx=ok&rid=/);
    const frag = parseReturnFragment(new URL(phone.returnTo!).hash)!;
    expect(frag.wk && frag.f).toBeTruthy();

    // iOS opens the return in a NEW tab: same localStorage, nothing else.
    const tabStorage = mapStorage();
    let cleaned = '';
    const r = await resumeReturnedPairing({ hash: new URL(phone.returnTo!).hash, href: phone.returnTo!, replaceUrl: (u) => (cleaned = u), returnStorage: returns, storage: tabStorage, socket: relay.socket });
    expect(cleaned).toBe(`${ORIGIN}/`);
    expect(r?.page).toBe(`${ORIGIN}/rooms/lounge`); // where the provider takes the user next
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
    // The old tab sleeps (hidden: it doesn't rejoin on its own while the new tab runs).
    siteSocket(relay, parsePairUrl(link).c)!.drop();
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
    // Back in Safari: the frozen socket is found closed, and the hash arrives (hashchange / pageshow).
    const old = siteSocket(relay, parsePairUrl(link).c)!;
    old.drop();
    old.wakeClosed();
    wake.fire();
    const w = await p;
    expect(w.signedIn?.identityKey).toBe(root.toPublicKey().toString());
    expect(hash).toBe('');
  });
});

describe('review 22 Nov: a forged return fragment', () => {
  /** What someone holding the link can build: their own pairing key, their own ready, their own sign-in. */
  const forge = async (link: string, attacker: PrivateKey) => {
    const l = parsePairUrl(link);
    const P = PrivateKey.fromRandom();
    const sealer = new Sealer((await deriveSession(P, l.k, l.c)).key, 'wallet');
    const message = loginMessageFor(l.o, l.ln!, l.lx!);
    const { signature } = await new ProtoWallet(attacker).createSignature({ protocolID: [2, 'bwallet sign in'], keyID: l.ln!, counterparty: 'anyone', data: Array.from(new TextEncoder().encode(message)) });
    const frame = await sealer.seal({ t: 'ready', login: { k: attacker.toPublicKey().toString(), sig: Utils.toHex(signature) } });
    return `#${returnFragment(l.rid!, P.toPublicKey().toString(), frame)}`;
  };
  const challenge = () => {
    const nonce = 'n0nce_' + Math.random().toString(36).slice(2, 12);
    return { nonce, expiresAt: new Date(Date.now() + 120_000).toISOString() };
  };

  it('never signs in a new tab without the relay confirming that wallet', async () => {
    const relay = new FakeRelay(ORIGIN);
    const returns = mapStorage();
    let link = '';
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: returns, socket: relay.socket, returnTo: PAGE, login: challenge(), onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await tick(5);
    const hash = await forge(link, PrivateKey.fromRandom());
    const tab = mapStorage();
    const r = await resumeReturnedPairing({ hash, href: `${ORIGIN}/${hash}`, replaceUrl: () => {}, returnStorage: returns, storage: tab, socket: relay.socket, waitMs: 300 });
    expect(r).toBeNull();
    expect(tab.m.size).toBe(0); // no pairing bound to the forger's key
  });

  it('a new tab with a forged fragment, then the real wallet: the real wallet wins', async () => {
    const relay = new FakeRelay(ORIGIN);
    const returns = mapStorage();
    const real = PrivateKey.fromRandom();
    const attacker = PrivateKey.fromRandom();
    let link = '';
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: returns, socket: relay.socket, returnTo: PAGE, login: challenge(), onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await tick(5);
    siteSocket(relay, parsePairUrl(link).c)!.drop(); // the tab sleeps; the real phone's frames queue at the relay
    fakePhone(link, relay.socket, real, { fold: true });
    await tick(20);
    const hash = await forge(link, attacker);
    const r = await resumeReturnedPairing({ hash, href: `${ORIGIN}/${hash}`, replaceUrl: () => {}, returnStorage: returns, storage: mapStorage(), socket: relay.socket, waitMs: 1000 });
    expect(r?.login?.identityKey).toBe(real.toPublicKey().toString());
  });

  it('never signs in the same tab on a forged fragment; the real wallet still can', async () => {
    const relay = new FakeRelay(ORIGIN);
    const wake = wakeHook();
    const real = PrivateKey.fromRandom();
    let link = '';
    let hash = '';
    let done: PairedWallet | null = null;
    const p = pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: mapStorage(), socket: relay.socket, onWake: wake.on, readHash: () => hash, replaceUrl: () => (hash = ''), returnTo: PAGE, login: challenge(), onCode: () => {}, onLink: (l) => (link = l) });
    p.then((w) => (done = w), () => {});
    await tick(5);
    hash = await forge(link, PrivateKey.fromRandom());
    wake.fire();
    await tick(50);
    expect(done).toBeNull();
    fakePhone(link, relay.socket, real, { fold: true });
    const w = await p;
    expect(w.signedIn?.identityKey).toBe(real.toPublicKey().toString());
  });
});

describe('review 22 Nov: spends are never re-sent', () => {
  it('a waiting createAction is not re-sent when the wallet says ready again; a read is', async () => {
    const relay = new FakeRelay(ORIGIN);
    const wake = wakeHook();
    const root = PrivateKey.fromRandom();
    let phone: ReturnType<typeof fakePhone> | undefined;
    const w = await pairBwalletX({
      origin: ORIGIN,
      storage: null,
      socket: relay.socket,
      onWake: wake.on,
      callTimeoutMs: 400,
      onCode: () => {},
      onLink: (l) => setTimeout(() => (phone = fakePhone(l, relay.socket, root, { slowActions: true })), 0),
    });
    const c = [...relay.channels.keys()][0];
    const s = siteSocket(relay, c)!;
    s.frozen = true;
    const spend = w.createAction({ description: 'test spend', outputs: [] } as never);
    let spendErr = null as { code?: string } | null;
    spend.catch((e) => (spendErr = e));
    const read = w.getPublicKey({ identityKey: true });
    await tick(10);
    s.drop();
    s.wakeClosed();
    wake.fire();
    await read;
    await tick(500);
    expect(phone!.requests.filter((a) => a === 'createAction').length).toBe(1);
    expect(spendErr?.code).toBe('NO_ANSWER_MAYBE_SENT');
  });
});

describe('review 2 (22 Nov)', () => {
  /** localStorage-like, with key()/length so stale entries can be found. */
  const listStorage = () => {
    const m = new Map<string, string>();
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
  };
  const ch = () => ({ nonce: 'n0nce_' + Math.random().toString(36).slice(2, 12), expiresAt: new Date(Date.now() + 120_000).toISOString() });

  it('(2) a spend that never went out (relay unreachable) is sent once when the link is back', async () => {
    const relay = new FakeRelay(ORIGIN);
    const wake = wakeHook();
    const root = PrivateKey.fromRandom();
    let phone: ReturnType<typeof fakePhone> | undefined;
    const w = await pairBwalletX({
      origin: ORIGIN,
      storage: null,
      socket: relay.socket,
      onWake: wake.on,
      callTimeoutMs: 3000,
      onCode: () => {},
      onLink: (l) => setTimeout(() => (phone = fakePhone(l, relay.socket, root)), 0),
    });
    const s = siteSocket(relay, [...relay.channels.keys()][0])!;
    s.drop();
    s.wakeClosed();
    relay.refuse = true;
    const spend = w.createAction({ description: 'x', outputs: [] } as never);
    await tick(30);
    relay.refuse = false;
    wake.fire();
    await spend;
    expect(phone!.requests.filter((a) => a === 'createAction').length).toBe(1);
  });

  it('(4) a tab whose return was taken by another tab never finishes too', async () => {
    const relay = new FakeRelay(ORIGIN);
    const returns = mapStorage();
    let link = '';
    let outcome: unknown = 'pending';
    const p = pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: returns, socket: relay.socket, returnTo: PAGE, login: ch(), onCode: () => {}, onLink: (l) => (link = l) });
    p.then(() => (outcome = 'ok'), (e) => (outcome = e));
    await tick(5);
    const old = siteSocket(relay, parsePairUrl(link).c)!;
    old.frozen = true;
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom(), { fold: true });
    await tick(20);
    // The new tab took the return first (resumeReturnedPairing deletes the entry once confirmed)…
    expect(returns.m.size).toBe(1);
    returns.m.clear();
    // …then the old tab wakes and its relay hands it hello and ready: it must stop, not finish a second sign-in.
    old.frozen = false;
    old.deliver(phone.hello);
    old.deliver(JSON.stringify(phone.readyFrame));
    await tick(20);
    expect((outcome as { code?: string })?.code).toBe('RETURNED_IN_ANOTHER_TAB');
  });

  it('(5) a taken return is deleted (it holds the pairing key), and stale ones go when a pairing starts', async () => {
    const relay = new FakeRelay(ORIGIN);
    const returns = listStorage();
    returns.setItem('bwalletx.connect.return.staleStaleStaleStale1', JSON.stringify({ v: 1, rid: 'staleStaleStaleStale1', at: Date.now() - 11 * 60_000, s: 'ab'.repeat(32) }));
    let link = '';
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: returns, socket: relay.socket, returnTo: PAGE, login: ch(), onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await tick(5);
    expect(returns.m.has('bwalletx.connect.return.staleStaleStaleStale1')).toBe(false);
    siteSocket(relay, parsePairUrl(link).c)!.drop();
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom(), { fold: true });
    await tick(20);
    const hash = new URL(phone.returnTo!).hash;
    expect(await resumeReturnedPairing({ hash, href: `${ORIGIN}/${hash}`, replaceUrl: () => {}, returnStorage: returns, storage: mapStorage(), socket: relay.socket })).not.toBeNull();
    expect([...returns.m.keys()].filter((k) => k.startsWith('bwalletx.connect.return.'))).toEqual([]);
  });

  it('(1) a site with a pairing key puts its proofs (s, s2) on the link', async () => {
    const relay = new FakeRelay(ORIGIN);
    const siteKey = PrivateKey.fromRandom();
    let link = '';
    void pairBwalletX({
      origin: ORIGIN,
      storage: null,
      returnStorage: mapStorage(),
      socket: relay.socket,
      returnTo: PAGE,
      browser: 'safari',
      login: ch(),
      proof: async (f) => signPairProofs(f, { origin: ORIGIN, key: siteKey }),
      onCode: () => {},
      onLink: (l) => (link = l),
    }).catch(() => {});
    await tick(20);
    const l = parsePairUrl(link);
    const pub = siteKey.toPublicKey();
    expect(pub.verify(Utils.toArray(`bwallet-pair-v1|proof|${l.c}|${l.k.toLowerCase()}|${l.o}|${l.e}`, 'utf8'), Signature.fromDER(Utils.toArray(l.s!, 'hex')))).toBe(true);
    expect(pub.verify(Utils.toArray(`bwallet-pair-v2|proof|${l.c}|${l.k.toLowerCase()}|${l.o}|${l.e}|${l.ret}|${l.rid}|${l.b}`, 'utf8'), Signature.fromDER(Utils.toArray(l.s2!, 'hex')))).toBe(true);
  });

  it('(1) the server signs only its own origin, its root as ret, and a live expiry', () => {
    const key = PrivateKey.fromRandom();
    const base = { c: 'Q2hhbm5lbElkMTIzNDU2Nw', k: PrivateKey.fromRandom().toPublicKey().toString(), o: ORIGIN, e: Math.floor(Date.now() / 1000) + 100 };
    expect(signPairProofs(base, { origin: ORIGIN, key })?.s).toMatch(/^30/);
    expect(signPairProofs({ ...base, o: 'https://evil.example' }, { origin: ORIGIN, key })).toBeNull();
    expect(signPairProofs({ ...base, e: base.e + 3600 }, { origin: ORIGIN, key })).toBeNull();
    expect(signPairProofs({ ...base, ret: `${ORIGIN}/deep/path`, rid: 'r'.repeat(22) }, { origin: ORIGIN, key })).toBeNull();
    expect(signPairProofs({ ...base, ret: `${ORIGIN}/`, rid: 'r'.repeat(22), b: 'safari' }, { origin: ORIGIN, key })?.s2).toMatch(/^30/);
  });
});

describe('the code helper', () => {
  it('signature in a folded login is hex DER', () => {
    expect(Utils.toHex([1, 2])).toBe('0102');
  });
});
