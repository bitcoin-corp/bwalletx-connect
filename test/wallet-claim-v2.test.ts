/**
 * 0.9.2: wallet claim v2 on the site side. A pairing learns `wv: 2` only from the wallet's SEALED ready (`nc` checked
 * against our own derivation), and then names the session claim's digest as `wc` on every reconnect, so the relay can
 * re-create a lost channel after its legacy cutoff (30 Nov 2026). A v1 pairing never sends the QR-bound digest to a
 * live channel. These run against the fake relay; test/relay-interop.test.ts runs the same flows against the real one.
 */
import { PrivateKey } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import { pairBwalletX, restorePairing, resumeReturnedPairing, type PairStorage, type SocketFactory } from '../src/pair';
import { DEFAULT_RELAY, claimDigest, parsePairUrl, relaySocketUrl, sessionWalletClaim, walletClaimFor } from '../src/protocol';
import { FakeRelay, type FakeSocket } from './fake-relay';
import { fakePhone, type FakePhoneOptions } from './phone';

const ORIGIN = 'https://example.com';
const KEY = 'bwalletx.connect.pairing.v1';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
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
const stored = (s: { m: Map<string, string> }) => JSON.parse(s.m.get(KEY)!);
const siteUrls = (relay: FakeRelay) => relay.urls.filter((u) => u.includes('role=site')).map((u) => new URL(u).searchParams);

async function pair(relay: FakeRelay, storage = mapStorage(), opts: FakePhoneOptions = {}, socket: SocketFactory = relay.socket) {
  let phone: ReturnType<typeof fakePhone> | null = null;
  const wallet = await pairBwalletX({
    origin: ORIGIN,
    storage,
    socket,
    onCode: () => {},
    onLink: (link) => setTimeout(() => (phone = fakePhone(link, relay.socket, PrivateKey.fromRandom(), opts)), 0),
  });
  return { wallet, phone: phone!, storage };
}

describe('wallet claim v2: the shared claim', () => {
  const P = PrivateKey.fromHex('11'.repeat(32));
  const S = PrivateKey.fromHex('22'.repeat(32));
  const C = 'AAAAAAAAAAAAAAAAAAAAAA';
  // Shared with bWalletX (src/pair/relayClaims.test.ts) and the bwalletx CLI: keep them in step.
  const VECTOR = 'rTgy5TUbOz2xUwLyqYebrIyLaQifFhULNSSHHklw0gQ';

  it('both ends compute the same claim, it matches the shared vector, and the QR alone does not give it', async () => {
    expect(sessionWalletClaim(P, S.toPublicKey().toString(), C)).toBe(VECTOR);
    expect(sessionWalletClaim(S, P.toPublicKey().toString(), C)).toBe(VECTOR);
    expect(VECTOR).toMatch(/^[A-Za-z0-9_-]{22,64}$/); // the relay's claim format
    expect(sessionWalletClaim(PrivateKey.fromRandom(), S.toPublicKey().toString(), C)).not.toBe(VECTOR);
    expect(await walletClaimFor(C, S.toPublicKey().toString())).not.toBe(VECTOR);
    expect(await claimDigest(VECTOR)).toBe('70d13b85c6bf389eafdc3d9b1c155826fda8517003bf2f4a8600b4dc0d06e759');
  });

  it('a wallet socket carries the digest as nc, a site socket as wc', () => {
    const d = 'f'.repeat(64);
    const w = new URL(relaySocketUrl(DEFAULT_RELAY, C, 'wallet', undefined, 'x'.repeat(22), d)).searchParams;
    expect(w.get('nc')).toBe(d);
    expect(w.get('wc')).toBeNull();
    const s = new URL(relaySocketUrl(DEFAULT_RELAY, C, 'site', 1, 'x'.repeat(22), d)).searchParams;
    expect(s.get('wc')).toBe(d);
    expect(s.get('nc')).toBeNull();
  });
});

describe('wallet claim v2: what the site stores', () => {
  it('a v2 wallet: the site stores wv 2 and names the session claim on every reconnect', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, phone, storage } = await pair(relay, undefined, { v2: true });
    expect(stored(storage).wv).toBe(2);
    wallet.close();
    const again = await restorePairing({ storage, socket: relay.socket });
    await again!.getPublicKey({ identityKey: true });
    const q = siteUrls(relay).at(-1)!;
    // Computed here only from our key and the phone's hello: the QR alone doesn't give it.
    expect(q.get('wc')).toBe(await claimDigest(phone.sessionClaim));
    expect(q.get('claim')).toBe(stored(storage).sc);
  });

  it("the plaintext hello's wcv is not trusted (review finding 4): no wv, no wc", async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay, undefined, { helloWcv: true });
    expect(stored(storage).wv).toBeUndefined();
    wallet.close();
    const again = await restorePairing({ storage, socket: relay.socket });
    await again!.getPublicKey({ identityKey: true });
    expect(siteUrls(relay).at(-1)!.get('wc')).toBeNull();
  });

  it('a ready naming a claim we do not derive changes nothing', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { storage } = await pair(relay, undefined, { v2: true, helloWcv: true, wrongNc: 'f'.repeat(64) });
    expect(stored(storage).wv).toBeUndefined();
  });

  it('a stored wv other than 2 is not a pairing', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { storage } = await pair(relay, undefined, { v2: true });
    storage.m.set(KEY, JSON.stringify({ ...stored(storage), wv: 3 }));
    expect(await restorePairing({ storage, socket: relay.socket })).toBeNull();
  });

  it('a pairing finished in the return tab stores wv 2 from the sealed ready too', async () => {
    const relay = new FakeRelay(ORIGIN);
    const returns = mapStorage();
    let link = '';
    const first = pairBwalletX({ origin: ORIGIN, storage: mapStorage(), returnStorage: returns, socket: relay.socket, returnTo: `${ORIGIN}/a`, onCode: () => {}, onLink: (l) => (link = l) });
    first.catch(() => {});
    await until(() => !!link);
    (relay.channels.get(parsePairUrl(link).c)!.site as FakeSocket).frozen = true; // the old tab sleeps
    const phone = fakePhone(link, relay.socket, PrivateKey.fromRandom(), { v2: true });
    await until(() => !!phone.returnTo);
    const tab = mapStorage();
    const r = await resumeReturnedPairing({ hash: new URL(phone.returnTo!).hash, href: phone.returnTo!, replaceUrl: () => {}, returnStorage: returns, storage: tab, socket: relay.socket });
    expect(r).not.toBeNull();
    expect(stored(tab).wv).toBe(2);
  });
});

describe('wallet claim v2: v1 pairings reconnect without the QR digest', () => {
  it('a v1 pairing reopens a live channel WITHOUT wc', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    expect(stored(storage).wv).toBeUndefined();
    wallet.close();
    const before = siteUrls(relay).length;
    const again = await restorePairing({ storage, socket: relay.socket });
    await again!.getPublicKey({ identityKey: true });
    const opened = siteUrls(relay).slice(before);
    expect(opened).toHaveLength(1);
    expect(opened[0].get('wc')).toBeNull();
    expect(opened[0].get('claim')).toBe(stored(storage).sc);
  });

  it('a v1 pairing upgrades when the sealed ready names the session claim, and names it from then on', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, phone, storage } = await pair(relay);
    expect(stored(storage).wv).toBeUndefined();
    await wallet.getPublicKey({ identityKey: true });
    // The phone (now 5.2.61) says ready with its session claim, as it does on every rejoin.
    phone.ws!.send(JSON.stringify(await phone.sealer!.seal({ t: 'ready', wcv: 2, nc: await claimDigest(phone.sessionClaim) })));
    await until(() => stored(storage).wv === 2);
    wallet.close();
    const again = await restorePairing({ storage, socket: relay.socket });
    await again!.getPublicKey({ identityKey: true });
    expect(siteUrls(relay).at(-1)!.get('wc')).toBe(await claimDigest(phone.sessionClaim));
  });

  it('refused (the relay lost the channel): one retry with the QR digest under a FRESH site claim, kept once open', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { sc: oldSc, c, s } = stored(storage);
    wallet.close();
    // After the cutoff the relay re-creates a channel only for a site that names the wallet binding (`wc`).
    const missing: SocketFactory = (url) => {
      const q = new URL(url).searchParams;
      relay.refuse = q.get('role') === 'site' && !q.get('wc');
      try {
        return relay.socket(url);
      } finally {
        relay.refuse = false;
      }
    };
    const before = siteUrls(relay).length;
    const again = await restorePairing({ storage, socket: missing });
    await again!.getPublicKey({ identityKey: true });
    const opened = siteUrls(relay).slice(before);
    expect(opened).toHaveLength(2);
    expect(opened[0].get('wc')).toBeNull();
    expect(opened[0].get('claim')).toBe(oldSc);
    const qr = await claimDigest(await walletClaimFor(c, PrivateKey.fromHex(s).toPublicKey().toString()));
    expect(opened[1].get('wc')).toBe(qr);
    // A fresh site claim: on a channel that still exists the relay refuses it before it reads `wc`.
    expect(opened[1].get('claim')).not.toBe(oldSc);
    expect(stored(storage).sc).toBe(opened[1].get('claim'));
  });

  it('refused twice: the site claim is kept, and nothing more is tried for that call', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { sc } = stored(storage);
    wallet.close();
    relay.refuse = true;
    const before = relay.urls.length;
    const again = await restorePairing({ storage, socket: relay.socket, callTimeoutMs: 300 });
    await expect(again!.getPublicKey({ identityKey: true })).rejects.toMatchObject({ code: 'NO_ANSWER' });
    // Refused sockets too: FakeRelay records every URL.
    const opened = relay.urls.slice(before).filter((u) => u.includes('role=site')).map((u) => new URL(u).searchParams);
    expect(opened).toHaveLength(2);
    expect(opened[0].get('wc')).toBeNull();
    expect(opened[1].get('wc')).not.toBeNull();
    expect(stored(storage).sc).toBe(sc);
  });

  it('a v2 pairing names only the session claim, never the QR digest, even when refused', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, phone, storage } = await pair(relay, undefined, { v2: true });
    const { c, s } = stored(storage);
    wallet.close();
    relay.refuse = true;
    const before = relay.urls.length;
    const again = await restorePairing({ storage, socket: relay.socket, callTimeoutMs: 300 });
    await expect(again!.getPublicKey({ identityKey: true })).rejects.toBeTruthy();
    const qr = await claimDigest(await walletClaimFor(c, PrivateKey.fromHex(s).toPublicKey().toString()));
    const tried = relay.urls.slice(before).filter((u) => u.includes('role=site')).map((u) => new URL(u).searchParams.get('wc'));
    expect(tried.length).toBeGreaterThan(0);
    for (const wc of tried) expect(wc).toBe(await claimDigest(phone.sessionClaim));
    expect(tried).not.toContain(qr);
  });
});
