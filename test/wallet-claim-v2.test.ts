/**
 * 0.9.2: wallet claim v2 on the site side. A pairing learns `wv: 2` only from the wallet's SEALED ready (`nc` checked
 * against our own derivation), and then names the session claim's digest as `wc` on every reconnect, so the relay can
 * re-create a lost channel after its legacy cutoff (30 Nov 2026). A v1 pairing never sends the QR-bound digest to a
 * live channel. These run against the fake relay; test/relay-interop.test.ts runs the same flows against the real one.
 */
import { PrivateKey } from '@bsv/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
/** Site sockets for channel `c` from index `from` of relay.urls (the reachability probe uses another channel). */
const siteUrlsOn = (relay: FakeRelay, c: string, from = 0) =>
  relay.urls
    .slice(from)
    .filter((u) => u.includes('role=site') && new URL(u).pathname.endsWith(`/${c}`))
    .map((u) => new URL(u).searchParams);
/** A relay that refuses the sockets `refuse` picks (refused sockets are still recorded). */
const refusing =
  (relay: FakeRelay, refuse: (q: URLSearchParams, url: string) => boolean): SocketFactory =>
  (url) => {
    relay.refuse = refuse(new URL(url).searchParams, url);
    try {
      return relay.socket(url);
    } finally {
      relay.refuse = false;
    }
  };

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

/**
 * The reachability check (pair.ts relayAnswers) fetches https://<relay>/health. Never the network here: by default the
 * relay doesn't answer; a test sets `answers` to make it.
 */
const health = { answers: false, calls: [] as { url: string; init?: RequestInit }[] };
beforeEach(() => {
  health.answers = false;
  health.calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    health.calls.push({ url, init });
    if (!health.answers) throw new TypeError('Failed to fetch');
    return new Response(null, { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * The relay's site-role rules for one channel, after the cutoff (relay.mjs admit/attach): a missing channel is created
 * only by a site that sends `wc`, and its claim is pinned at the upgrade; after that only that claim gets in.
 */
function channelModel(relay: FakeRelay, c: string) {
  const m = { owner: null as string | null };
  const socket = refusing(relay, (q, url) => {
    if (!new URL(url).pathname.endsWith(`/${c}`) || q.get('role') !== 'site') return false;
    const claim = q.get('claim');
    if (m.owner === null) {
      if (!q.get('wc') || !claim) return true; // "wallet binding required"
      m.owner = claim;
      return false;
    }
    return claim !== m.owner; // "role claimed"
  });
  return { m, socket };
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

  it('an unknown wv is ignored (treated as v1), and the pairing is kept (review of #24, finding 4)', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay, undefined, { v2: true });
    wallet.close();
    storage.m.set(KEY, JSON.stringify({ ...stored(storage), wv: 3 }));
    const again = await restorePairing({ storage, socket: relay.socket });
    expect(again).not.toBeNull();
    await again!.getPublicKey({ identityKey: true });
    expect(siteUrls(relay).at(-1)!.get('wc')).toBeNull(); // v1: no wc on a live channel
    expect(storage.m.get(KEY)).toBeTruthy();
    expect(stored(storage).wv).not.toBe(3);
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
    let pendingAtOpen: string | undefined;
    const missing = refusing(relay, (q) => {
      if (q.get('wc')) pendingAtOpen = stored(storage).sn; // what a page that dies right now would still have
      return q.get('role') === 'site' && !q.get('wc');
    });
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
    // Saved as pending BEFORE that socket opened (finding 1), and ours once it did.
    expect(pendingAtOpen).toBe(opened[1].get('claim'));
    expect(stored(storage).sc).toBe(opened[1].get('claim'));
    expect(stored(storage).sn).toBeUndefined();
  });

  it('a pending claim the relay pinned before the page saw onopen is tried next, without wc, and kept (finding 1)', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { sc: oldSc, c } = stored(storage);
    wallet.close();
    // The last page saved `sn`, opened with it (the relay pinned it), and died before onopen.
    const sn = 'pendingPendingPending1';
    storage.m.set(KEY, JSON.stringify({ ...stored(storage), sn }));
    const before = relay.urls.length;
    const again = await restorePairing({ storage, socket: refusing(relay, (q) => q.get('claim') === oldSc) });
    await again!.getPublicKey({ identityKey: true });
    const opened = siteUrlsOn(relay, c, before);
    expect(opened.map((q) => q.get('claim'))).toEqual([oldSc, sn]);
    expect(opened.map((q) => q.get('wc'))).toEqual([null, null]);
    expect(stored(storage).sc).toBe(sn);
    expect(stored(storage).sn).toBeUndefined();
  });

  it('another tab rotated the site claim: the next reconnect here uses the stored one and writes nothing stale', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { sc: oldSc, c } = stored(storage);
    wallet.close();
    // Tab B is loaded now, with the old claim in memory; it connects only later.
    let refuseOld = false;
    const tabB = await restorePairing({ storage, socket: refusing(relay, (q) => refuseOld && q.get('claim') === oldSc), callTimeoutMs: 500 });
    // Tab A re-creates the lost channel under a fresh claim.
    const tabA = await restorePairing({ storage, socket: refusing(relay, (q) => q.get('role') === 'site' && !q.get('wc')) });
    await tabA!.getPublicKey({ identityKey: true });
    const rotated = stored(storage).sc;
    expect(rotated).not.toBe(oldSc);
    tabA!.close();
    // The relay now refuses the old claim. Tab B reconnects with the rotated one, first time, and writes nothing stale.
    refuseOld = true;
    const before = relay.urls.length;
    // (Unanswered: two live tabs share one pairing's frame counters, so the phone drops tab B's frames as replays. That
    // is older than 0.9.2 and is why other tabs need a reload; what matters here is the claim it presents and keeps.)
    await expect(tabB!.getPublicKey({ identityKey: true })).rejects.toMatchObject({ code: 'NO_ANSWER' });
    expect(siteUrlsOn(relay, c, before).map((q) => q.get('claim'))).toEqual([rotated]);
    expect(stored(storage).sc).toBe(rotated);
    expect(stored(storage).sn).toBeUndefined();
  });

  it('every claim refused by a relay that answers: REPAIR_NEEDED at once, and no retry loop (finding 1)', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { c } = stored(storage);
    wallet.close();
    const before = relay.urls.length;
    // Our channel refuses everything, and the relay answers /health.
    health.answers = true;
    const lockedOut = refusing(relay, (_q, url) => new URL(url).pathname.endsWith(`/${c}`));
    const again = await restorePairing({ storage, socket: lockedOut, callTimeoutMs: 60_000 });
    await expect(again!.getPublicKey({ identityKey: true })).rejects.toMatchObject({ code: 'REPAIR_NEEDED' });
    const tried = siteUrlsOn(relay, c, before);
    // sc, fresh (QR wc), then once /health answered: sc, the pending claim (no wc), one more fresh (QR wc).
    expect(tried.map((q) => !!q.get('wc'))).toEqual([false, true, false, false, true]);
    expect(relay.urls.slice(before).filter((u) => !u.includes(`/${c}?`))).toEqual([]); // no probe channel
    expect(health.calls).toHaveLength(1);
    expect(health.calls[0].url).toBe('https://relay.bwallet.space/health');
    expect(health.calls[0].init).toMatchObject({ mode: 'no-cors', credentials: 'omit' });
    await tick(1500);
    expect(siteUrlsOn(relay, c, before)).toHaveLength(5); // nothing more: no loop
    // Later calls fail at once (re-check of #24): no sockets, no /health.
    await expect(again!.getPublicKey({ identityKey: true })).rejects.toMatchObject({ code: 'REPAIR_NEEDED' });
    expect(siteUrlsOn(relay, c, before)).toHaveLength(5);
    expect(health.calls).toHaveLength(1);
    expect(await restorePairing({ storage, socket: relay.socket })).not.toBeNull(); // the record is kept
  });

  it('after REPAIR_NEEDED, a change to the stored claims (another tab) is worth one more try', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { c } = stored(storage);
    wallet.close();
    health.answers = true;
    let lockedOut = true;
    const again = await restorePairing({ storage, socket: refusing(relay, (_q, url) => lockedOut && new URL(url).pathname.endsWith(`/${c}`)), callTimeoutMs: 2000 });
    await expect(again!.getPublicKey({ identityKey: true })).rejects.toMatchObject({ code: 'REPAIR_NEEDED' });
    // Another tab got back in under a claim it stored.
    lockedOut = false;
    storage.m.set(KEY, JSON.stringify({ ...stored(storage), sc: 'otherTabOtherTabOtherT', sn: undefined }));
    const before = relay.urls.length;
    await again!.getPublicKey({ identityKey: true });
    expect(siteUrlsOn(relay, c, before)[0].get('claim')).toBe('otherTabOtherTabOtherT');
  });

  it('two tabs hit the missing channel at once: one creates it, the other uses its claim; no false REPAIR_NEEDED', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { c, sc: oldSc } = stored(storage);
    wallet.close();
    health.answers = true;
    const model = channelModel(relay, c);
    const before = relay.urls.length;
    // Both tabs loaded the same record; the relay has lost the channel.
    const tabA = await restorePairing({ storage, socket: model.socket, callTimeoutMs: 600 });
    const tabB = await restorePairing({ storage, socket: model.socket, callTimeoutMs: 600 });
    const outcomes = await Promise.all(
      [tabA!, tabB!].map((t) =>
        t.getPublicKey({ identityKey: true }).then(
          () => 'answered',
          (e: { code?: string }) => e.code,
        ),
      ),
    );
    // (Two live tabs share the frame counters, so the phone may answer only one: NO_ANSWER is fine, REPAIR_NEEDED isn't.)
    expect(outcomes).not.toContain('REPAIR_NEEDED');
    expect(outcomes).toContain('answered');
    // Compare-and-set: only one tab rotated (one QR-digest socket); the other took that tab's pending claim.
    expect(siteUrlsOn(relay, c, before).filter((q) => q.get('wc'))).toHaveLength(1);
    // The record holds the claim the relay pinned, with nothing pending: neither tab wrote over the other.
    expect(model.m.owner).not.toBe(oldSc);
    expect(stored(storage).sc).toBe(model.m.owner);
    expect(stored(storage).sn).toBeUndefined();
    // And a fresh page load gets straight in with it.
    const tabC = await restorePairing({ storage, socket: model.socket, callTimeoutMs: 600 });
    const later = relay.urls.length;
    await tabC!.getPublicKey({ identityKey: true }).catch(() => {});
    expect(siteUrlsOn(relay, c, later).map((q) => q.get('claim'))).toEqual([model.m.owner]);
  });

  it("a dead page's pending claim that never reached the relay: replaced once it is 30 s old, and the channel re-created", async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { c } = stored(storage);
    wallet.close();
    health.answers = true;
    // Young (another tab may still be opening with it): not raced, and not a REPAIR_NEEDED verdict either.
    storage.m.set(KEY, JSON.stringify({ ...stored(storage), sn: 'deadPageDeadPageDeadPa', sa: Date.now() }));
    const young = channelModel(relay, c);
    let before = relay.urls.length;
    const t1 = await restorePairing({ storage, socket: young.socket, callTimeoutMs: 400 });
    await expect(t1!.getPublicKey({ identityKey: true })).rejects.toMatchObject({ code: 'NO_ANSWER' });
    expect(siteUrlsOn(relay, c, before).filter((q) => q.get('wc'))).toEqual([]);
    expect(stored(storage).sn).toBe('deadPageDeadPageDeadPa');
    t1!.close();
    // Old: the page that wrote it is gone. One fresh claim (QR digest) re-creates the channel.
    storage.m.set(KEY, JSON.stringify({ ...stored(storage), sa: Date.now() - 60_000 }));
    const old = channelModel(relay, c);
    before = relay.urls.length;
    const t2 = await restorePairing({ storage, socket: old.socket, callTimeoutMs: 2000 });
    await t2!.getPublicKey({ identityKey: true });
    expect(siteUrlsOn(relay, c, before).filter((q) => q.get('wc'))).toHaveLength(1);
    expect(stored(storage).sc).toBe(old.m.owner);
    expect(stored(storage).sn).toBeUndefined();
  });

  it('a claim another tab stores while we try is used before the REPAIR_NEEDED verdict', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay, undefined, { v2: true }); // v2: no fresh claim of our own to try
    const { c, sc } = stored(storage);
    wallet.close();
    const tab = await restorePairing({ storage, socket: refusing(relay, (q, url) => new URL(url).pathname.endsWith(`/${c}`) && q.get('claim') !== 'otherTabOtherTabOtherT'), callTimeoutMs: 2000 });
    // Our claim is refused; while we check /health, another tab gets in under its own claim and stores it.
    health.answers = true;
    vi.stubGlobal('fetch', async () => {
      storage.m.set(KEY, JSON.stringify({ ...stored(storage), sc: 'otherTabOtherTabOtherT' }));
      return new Response(null, { status: 200 });
    });
    const before = relay.urls.length;
    await tab!.getPublicKey({ identityKey: true });
    expect(siteUrlsOn(relay, c, before).map((q) => q.get('claim'))).toEqual([sc, sc, 'otherTabOtherTabOtherT']);
  });

  it('refused twice: the site claim is kept, and nothing more is tried for that call', async () => {
    const relay = new FakeRelay(ORIGIN);
    const { wallet, storage } = await pair(relay);
    const { sc } = stored(storage);
    wallet.close();
    relay.refuse = true;
    const before = relay.urls.length;
    const again = await restorePairing({ storage, socket: relay.socket, callTimeoutMs: 300 });
    // Unreachable (/health fails too): not REPAIR_NEEDED, the call just gets no answer.
    await expect(again!.getPublicKey({ identityKey: true })).rejects.toMatchObject({ code: 'NO_ANSWER' });
    const opened = siteUrlsOn(relay, stored(storage).c, before); // refused sockets are recorded too
    expect(opened).toHaveLength(2);
    expect(opened[0].get('wc')).toBeNull();
    expect(opened[1].get('wc')).not.toBeNull();
    expect(stored(storage).sc).toBe(sc);
    expect(stored(storage).sn).toBe(opened[1].get('claim')); // kept as pending: the relay may have pinned it
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
    const tried = siteUrlsOn(relay, c, before).map((q) => q.get('wc'));
    expect(tried.length).toBeGreaterThan(0);
    for (const wc of tried) expect(wc).toBe(await claimDigest(phone.sessionClaim));
    expect(tried).not.toContain(qr);
  });
});
