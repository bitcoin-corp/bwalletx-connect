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
import { Sealer, deriveSession, loginMessageFor, parsePairUrl, parseReturnFragment, returnFragment } from '../src/protocol';
import { FakeRelay, FakeSocket } from './fake-relay';
import { fakePhone } from './phone';

const ORIGIN = 'https://example.com';
const PAGE = 'https://example.com/rooms/lounge?x=1';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Wait on a condition, not a fixed time (review 4: fixed ticks flaked under the full parallel run). */
const until = async (ok: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!ok()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await tick(5);
  }
};
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
    await until(() => !!link);
    const c = parsePairUrl(link).c;
    // The user taps "Open bWalletX": Safari goes to the background and iOS kills the tab's socket.
    const old = siteSocket(relay, c)!;
    old.drop();
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom());
    await until(() => !!phone.readyFrame);
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
    await until(() => !!link);
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
    await until(() => !!link);
    expect(parsePairUrl(link).ret).toBeUndefined();
  });

  it('a folded sign-in (from the return, same tab) is answered by the paired wallet without another trip', async () => {
    const relay = new FakeRelay(ORIGIN);
    const root = PrivateKey.fromRandom();
    const ch = challenge();
    const wake = wakeHook();
    let hash = '';
    let phone: ReturnType<typeof fakePhone> | undefined;
    const p = pairBwalletX({
      origin: ORIGIN,
      storage: null,
      returnStorage: mapStorage(),
      socket: relay.socket,
      onWake: wake.on,
      readHash: () => hash,
      replaceUrl: () => (hash = ''),
      returnTo: PAGE,
      login: ch,
      onCode: () => {},
      onLink: (l) => setTimeout(() => (phone = fakePhone(l, relay.socket, root, { fold: true })), 0),
    });
    await until(() => !!phone?.returnTo);
    hash = new URL(phone!.returnTo!).hash; // the wallet opens the return in this tab
    wake.fire();
    const w = await p;
    expect(w.signedIn?.identityKey).toBe(root.toPublicKey().toString());
    const [{ publicKey }, { signature }] = await Promise.all([
      w.getPublicKey({ identityKey: true }),
      w.createSignature({ protocolID: [2, 'bwallet sign in'], keyID: ch.nonce, counterparty: 'anyone', data: Array.from(new TextEncoder().encode(ch.message)) }),
    ]);
    expect(phone!.requests).toEqual([]); // nothing went to the phone: it is asleep by now
    expect(publicKey).toBe(root.toPublicKey().toString());
    expect(Signature.fromDER(signature).toDER().length).toBeGreaterThan(60);
  });

  it('CTO 22 Nov: a sign-in signature that arrives over the RELAY is never used', async () => {
    const relay = new FakeRelay(ORIGIN);
    const w = await pairBwalletX({
      origin: ORIGIN,
      storage: null,
      returnStorage: mapStorage(),
      socket: relay.socket,
      returnTo: PAGE,
      login: challenge(),
      onCode: () => {},
      onLink: (l) => setTimeout(() => fakePhone(l, relay.socket, PrivateKey.fromRandom(), { loginOverRelay: true }), 0),
    });
    expect(w.signedIn).toBeUndefined();
  });

  it('CTO 22 Nov: "signed in, see the return" with no return coming falls back to the usual sign-in request', async () => {
    const relay = new FakeRelay(ORIGIN);
    const w = await pairBwalletX({
      origin: ORIGIN,
      storage: null,
      returnStorage: mapStorage(),
      socket: relay.socket,
      returnTo: PAGE,
      returnWaitMs: 100,
      login: challenge(),
      onCode: () => {},
      onLink: (l) => setTimeout(() => fakePhone(l, relay.socket, PrivateKey.fromRandom(), { fold: true }), 0),
    });
    expect(w.signedIn).toBeUndefined(); // paired; the sign-in then goes as a request (the wallet's separate sheet)
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
    await until(() => !!link);
    const c = parsePairUrl(link).c;
    siteSocket(relay, c)!.frozen = true; // the old tab is asleep: hello and ready are swallowed
    const phone = fakePhone(link, relay.socket, root, { fold: true });
    await until(() => !!phone.readyFrame);
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
    await until(() => !!link); // not a fixed tick: the link comes after two digests (flaked under load)
    // The old tab sleeps (hidden: it doesn't rejoin on its own while the new tab runs).
    siteSocket(relay, parsePairUrl(link).c)!.drop();
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom(), { fold: true });
    await until(() => !!phone.readyFrame);
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
    await until(() => !!link);
    siteSocket(relay, parsePairUrl(link).c)!.frozen = true;
    const phone = fakePhone(link, relay.socket, root, { fold: true });
    await until(() => !!phone.readyFrame);
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
    await until(() => !!link);
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
    await until(() => !!link);
    siteSocket(relay, parsePairUrl(link).c)!.drop(); // the tab sleeps; the real phone's frames queue at the relay
    const realPhone = fakePhone(link, relay.socket, real, { fold: true });
    await until(() => !!realPhone.readyFrame);
    const hash = await forge(link, attacker);
    const r = await resumeReturnedPairing({ hash, href: `${ORIGIN}/${hash}`, replaceUrl: () => {}, returnStorage: returns, storage: mapStorage(), socket: relay.socket, waitMs: 1000 });
    // The real wallet pairs (over the relay). The forger's sign-in is never used, and the real one never travels over
    // the relay (CTO 22 Nov), so this tab has no sign-in from the forged fragment: it asks the usual way.
    expect(r).not.toBeNull();
    expect(r?.login?.identityKey).not.toBe(attacker.toPublicKey().toString());
    expect(r?.login).toBeNull();
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
    await until(() => !!link);
    hash = await forge(link, PrivateKey.fromRandom());
    wake.fire();
    await tick(50);
    expect(done).toBeNull();
    const phone = fakePhone(link, relay.socket, real, { fold: true });
    await until(() => !!phone.returnTo);
    hash = new URL(phone.returnTo!).hash; // the real wallet's own return
    wake.fire();
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

describe('review 4 (22 Nov)', () => {
  it('(L4) a waiting sign-in signature is not re-sent either: only reads are', async () => {
    const relay = new FakeRelay(ORIGIN);
    const wake = wakeHook();
    let phone: ReturnType<typeof fakePhone> | undefined;
    const w = await pairBwalletX({
      origin: ORIGIN,
      storage: null,
      socket: relay.socket,
      onWake: wake.on,
      callTimeoutMs: 400,
      onCode: () => {},
      onLink: (l) => setTimeout(() => (phone = fakePhone(l, relay.socket, PrivateKey.fromRandom(), { slow: ['createSignature'] })), 0),
    });
    const s = siteSocket(relay, [...relay.channels.keys()][0])!;
    s.frozen = true;
    const sig = w.createSignature({ protocolID: [2, 'bwallet sign in'], keyID: 'n0nce_abcdef', counterparty: 'anyone', data: [1, 2, 3] });
    sig.catch(() => undefined);
    const read = w.getPublicKey({ identityKey: true });
    await until(() => (phone?.requests.length ?? 0) >= 2);
    s.drop();
    s.wakeClosed();
    wake.fire();
    await read;
    await tick(500);
    expect(phone!.requests.filter((a) => a === 'createSignature').length).toBe(1);
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
    await until(() => !!link);
    const old = siteSocket(relay, parsePairUrl(link).c)!;
    old.frozen = true;
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom(), { fold: true });
    await until(() => !!phone.readyFrame);
    // The new tab took the return first (resumeReturnedPairing deletes the entry once confirmed)…
    expect(returns.m.size).toBe(1);
    returns.m.clear();
    // …then the old tab wakes and its relay hands it hello and ready: it must stop, not finish a second sign-in.
    old.frozen = false;
    old.deliver(phone.hello);
    old.deliver(JSON.stringify(phone.readyFrame));
    await until(() => outcome !== 'pending');
    expect((outcome as { code?: string })?.code).toBe('RETURNED_IN_ANOTHER_TAB');
  });

  it('(5) a taken return is deleted (it holds the pairing key), and stale ones go when a pairing starts', async () => {
    const relay = new FakeRelay(ORIGIN);
    const returns = listStorage();
    returns.setItem('bwalletx.connect.return.staleStaleStaleStale1', JSON.stringify({ v: 1, rid: 'staleStaleStaleStale1', at: Date.now() - 11 * 60_000, s: 'ab'.repeat(32) }));
    let link = '';
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: returns, socket: relay.socket, returnTo: PAGE, login: ch(), onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await until(() => !!link); // not a fixed tick: the link comes after two digests (flaked under load)
    expect(returns.m.has('bwalletx.connect.return.staleStaleStaleStale1')).toBe(false);
    siteSocket(relay, parsePairUrl(link).c)!.drop();
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom(), { fold: true });
    await until(() => !!phone.readyFrame);
    const hash = new URL(phone.returnTo!).hash;
    expect(await resumeReturnedPairing({ hash, href: `${ORIGIN}/${hash}`, replaceUrl: () => {}, returnStorage: returns, storage: mapStorage(), socket: relay.socket })).not.toBeNull();
    expect([...returns.m.keys()].filter((k) => k.startsWith('bwalletx.connect.return.'))).toEqual([]);
  });

  it('review 3 (1): no origin-proof machinery: the link never carries s or s2, and connect has no proof route', async () => {
    const relay = new FakeRelay(ORIGIN);
    let link = '';
    void pairBwalletX({ origin: ORIGIN, storage: null, returnStorage: mapStorage(), socket: relay.socket, returnTo: PAGE, login: ch(), onCode: () => {}, onLink: (l) => (link = l) }).catch(() => {});
    await until(() => !!link);
    const q = new URL(link).searchParams;
    expect(q.has('s')).toBe(false);
    expect(q.has('s2')).toBe(false);
    expect(q.get('ret')).toBe(`${ORIGIN}/`);
    const server = (await import('../src/server')) as Record<string, unknown>;
    expect(server.signPairProofs).toBeUndefined();
    expect(server.pairKeysDocument).toBeUndefined();
  });
});

describe('the code helper', () => {
  it('signature in a folded login is hex DER', () => {
    expect(Utils.toHex([1, 2])).toBe('0102');
  });
});

describe('browser hint (CTO 22 Nov: Android browsers the wallet can return to by package)', () => {
  it('names Opera, Chrome and Samsung on Android', async () => {
    const { browserHint } = await import('../src/protocol');
    expect(browserHint('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 OPR/85.0')).toBe('opera');
    expect(browserHint('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')).toBe('chrome');
    expect(browserHint('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/130.0 Mobile Safari/537.36')).toBe('samsung');
  });
});
