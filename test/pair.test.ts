import { PrivateKey } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import { pairBwalletX, restorePairing, type PairStorage } from '../src/pair';
import { DEFAULT_RELAY, QR_LIFETIME_S, Sealer, claimDigest, deriveSession, isSealed, newChannel, pairUrl, parsePairUrl, relaySocketUrl, walletClaimFor, type HelloFrame } from '../src/protocol';
import { FakeRelay } from './fake-relay';
import { fakePhone } from './phone';

const ORIGIN = 'https://example.com';
const mapStorage = (): PairStorage & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

describe('frame ordering', () => {
  it('reproduces the race: a handler that does not queue drops ready sent right after hello', async () => {
    const relay = new FakeRelay(ORIGIN);
    const S = PrivateKey.fromRandom();
    const c = newChannel();
    const e = Math.floor(Date.now() / 1000) + QR_LIFETIME_S;
    const ws = relay.socket(relaySocketUrl(DEFAULT_RELAY, c, 'site', e));
    let sealer: Sealer | null = null;
    let ready = false;
    // The handler shape from before the fix (also in bit-sign and the CLI): async, not queued.
    ws.onmessage = async (ev) => {
      const f = JSON.parse(String(ev.data));
      if ((f as HelloFrame).t === 'hello' && !sealer) {
        const s = await deriveSession(S, (f as HelloFrame).k, c);
        sealer = new Sealer(s.key, 'site');
        return;
      }
      if (!sealer || !isSealed(f)) return;
      if ((await sealer.open(f))?.t === 'ready') ready = true;
    };
    await new Promise((r) => setTimeout(r, 0));
    fakePhone(pairUrl({ v: '1', r: DEFAULT_RELAY, c, k: S.toPublicKey().toString(), o: ORIGIN, e }), relay.socket, PrivateKey.fromRandom(), { burst: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(sealer).not.toBeNull(); // hello was handled...
    expect(ready).toBe(false); // ...but ready arrived while the key was being derived, and was dropped
  });

  it('pairBwalletX handles hello and ready in order, even back to back', async () => {
    const relay = new FakeRelay(ORIGIN);
    const root = PrivateKey.fromRandom();
    let phone: ReturnType<typeof fakePhone> | undefined;
    let code = '';
    const wallet = await pairBwalletX({
      origin: ORIGIN,
      storage: null,
      socket: relay.socket,
      onCode: (c) => (code = c),
      onLink: (link) => setTimeout(() => (phone = fakePhone(link, relay.socket, root, { burst: true })), 0),
    });
    expect(code).toMatch(/^\d{4}$/);
    expect(code).toBe(phone!.code);
    const { publicKey } = await wallet.getPublicKey({ identityKey: true });
    expect(publicKey).toBe(root.toPublicKey().toString());
  });
});

describe('pairing survives a reload', () => {
  it('restorePairing reconnects with the stored key and counters', async () => {
    const relay = new FakeRelay(ORIGIN);
    const root = PrivateKey.fromRandom();
    const storage = mapStorage();
    let phone: ReturnType<typeof fakePhone> | undefined;
    const first = await pairBwalletX({
      origin: ORIGIN,
      storage,
      socket: relay.socket,
      onCode: () => {},
      onLink: (link) => setTimeout(() => (phone = fakePhone(link, relay.socket, root)), 0),
    });
    await first.getPublicKey({ identityKey: true });
    first.close(); // "reload"
    const before = JSON.parse(storage.m.get('bwalletx.connect.pairing.v1')!);
    expect(before.sent).toBe(1);

    const again = await restorePairing({ storage, socket: relay.socket });
    expect(again).not.toBeNull();
    const { publicKey } = await again!.getPublicKey({ identityKey: true });
    expect(publicKey).toBe(root.toPublicKey().toString());
    expect(phone!.requests).toEqual(['getPublicKey', 'getPublicKey']);
    const after = JSON.parse(storage.m.get('bwalletx.connect.pairing.v1')!);
    expect(after.sent).toBe(2);
    expect(after.lastSeen).toBe(3); // ready, res, res

    await again!.forget();
    expect(storage.m.size).toBe(0);
    expect(await restorePairing({ storage, socket: relay.socket })).toBeNull();
  });
});

describe('relay role claims (b-Aware 26 Oct 2026, N3-1/N3-2)', () => {
  it('the site opens the channel with its own claim and the digest of the QR-bound wallet claim, and reconnects with the same claim', async () => {
    const relay = new FakeRelay(ORIGIN);
    const root = PrivateKey.fromRandom();
    const storage = mapStorage();
    let qr = '';
    const first = await pairBwalletX({
      origin: ORIGIN,
      storage,
      socket: relay.socket,
      onCode: () => {},
      onLink: (link) => {
        qr = link;
        setTimeout(() => fakePhone(link, relay.socket, root), 0);
      },
    });
    const opened = new URL(relay.urls.find((u) => u.includes('role=site'))!);
    const claim = opened.searchParams.get('claim')!;
    expect(claim).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    const link = parsePairUrl(qr);
    expect(opened.searchParams.get('wc')).toBe(await claimDigest(await walletClaimFor(link.c, link.k)));
    expect(JSON.parse(storage.m.get('bwalletx.connect.pairing.v1')!).sc).toBe(claim);

    await first.getPublicKey({ identityKey: true });
    first.close();
    const again = await restorePairing({ storage, socket: relay.socket });
    await again!.getPublicKey({ identityKey: true });
    const reopened = new URL(relay.urls.filter((u) => u.includes('role=site')).pop()!);
    expect(reopened.searchParams.get('claim')).toBe(claim);
    expect(reopened.searchParams.get('wc')).toBeNull(); // only a fresh QR channel carries the wallet binding
  });

  it('a pairing stored before claims gets one on reconnect and keeps it', async () => {
    const relay = new FakeRelay(ORIGIN);
    const storage = mapStorage();
    await pairBwalletX({
      origin: ORIGIN,
      storage,
      socket: relay.socket,
      onCode: () => {},
      onLink: (link) => setTimeout(() => fakePhone(link, relay.socket, PrivateKey.fromRandom()), 0),
    }).then((w) => w.close());
    const old = JSON.parse(storage.m.get('bwalletx.connect.pairing.v1')!);
    delete old.sc;
    storage.m.set('bwalletx.connect.pairing.v1', JSON.stringify(old));
    const again = await restorePairing({ storage, socket: relay.socket });
    await again!.getPublicKey({ identityKey: true });
    const sc = JSON.parse(storage.m.get('bwalletx.connect.pairing.v1')!).sc;
    expect(sc).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(new URL(relay.urls.at(-1)!).searchParams.get('claim')).toBe(sc);
  });
});
