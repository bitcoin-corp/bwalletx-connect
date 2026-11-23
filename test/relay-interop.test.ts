/**
 * 0.9.2 interop: this package's pairing (src/pair.ts) against the REAL bWalletX relay (test/fixtures/relay.mjs, a copy
 * of relay/relay.mjs as shipped with 5.2.61) after its legacy-claims cutoff (legacyUntil: 0, as from 30 Nov 2026), and
 * a phone simulator that follows bWalletX 5.2.61 (src/mobile/pair/sessions.ts) or an older build without wallet claim
 * v2. Ported from the PR #20 reviewer's harness. Scenarios:
 *   A  a v2 pairing re-creates a channel the relay dropped (31-day idle), bound to the phone's session claim;
 *   B  a pairing stored without wv (0.9.1) and a 5.2.61 phone: the channel is lost, the site re-creates it with the QR
 *      digest, the phone binds its session claim and the site upgrades to wv 2;
 *   C  the downgrade from PR #20 is refused: a v1-stored pairing reconnecting to a LIVE channel never re-binds it to
 *      the QR digest, so whoever saw the QR can't evict the phone;
 *   D  an older phone holding the QR claim (no nc) still works, on a live channel and after a lost one.
 * Review of #24, finding 1: a fresh claim the relay pinned before the page saw onopen gets back in (it was saved as
 * pending first), and a channel someone else holds ends in REPAIR_NEEDED instead of a retry loop.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrivateKey } from '@bsv/sdk';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restorePairing, pairBwalletX, type PairStorage, type PairedWallet, type SocketLike } from '../src/pair';
import {
  Sealer,
  claimDigest,
  deriveSession,
  isSealed,
  parsePairUrl,
  relaySocketUrl,
  sessionWalletClaim,
  walletClaimFor,
  type PairLink,
  type PairMessage,
} from '../src/protocol';
import { createRelay } from './fixtures/relay.mjs';

const ORIGIN = 'https://example.com';
const RELAY = 'relay.test'; // the host stored in pairings; sockets are routed to `target`
const KEY = 'bwalletx.connect.pairing.v1';
const DAY = 24 * 60 * 60_000;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms = 5000) => {
  const t = Date.now();
  while (!(await ok())) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await tick(10);
  }
};

let offset = 0; // the relay's clock runs `offset` ms ahead of ours
let target = ''; // where relay.test routes: a fresh relay instance = a lost state file
const cleanups: (() => unknown)[] = [];
const realFetch = globalThis.fetch;
const healthChecks: string[] = [];
beforeEach(() => {
  // connect asks https://<relay>/health whether the relay answers (pair.ts relayAnswers): route it like the sockets.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    healthChecks.push(url);
    const u = new URL(url);
    u.protocol = 'http:';
    u.host = target;
    return realFetch(u.toString(), init);
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  healthChecks.length = 0;
  for (const f of cleanups.splice(0).reverse()) await f();
  offset = 0;
});

async function boot() {
  // /health as relay/server.mjs serves it, on the same host as the sockets.
  const server = createServer((req, res) => {
    if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    res.writeHead(404).end();
  });
  const relay = createRelay({ server, legacyUntil: 0, now: () => Date.now() + offset }); // after the 30 Nov cutoff
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  let down = false;
  const stop = async () => {
    if (down) return;
    down = true;
    relay.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  cleanups.push(stop);
  target = host;
  return { relay, host, stop };
}

const routed = (url: string) => {
  const u = new URL(url);
  u.protocol = 'ws:';
  u.host = target;
  return u.toString();
};
const siteUrls: URLSearchParams[] = [];
/** The site's sockets, as a browser opens them (the relay checks Origin). */
const siteSocket = (url: string): SocketLike => {
  siteUrls.push(new URL(url).searchParams);
  const ws = new WebSocket(routed(url), { origin: ORIGIN });
  ws.on('error', () => {}); // a refused upgrade: pair.ts hears it through onerror/onclose, as in a browser
  cleanups.push(() => ws.terminate());
  return ws as unknown as SocketLike;
};
/** Open a raw socket; resolves 'open' or the HTTP status the relay refused it with. */
const tryOpen = (url: string, origin?: string) =>
  new Promise<'open' | number>((resolve) => {
    const ws = new WebSocket(routed(url), origin ? { origin } : {});
    cleanups.push(() => ws.terminate());
    ws.on('open', () => resolve('open'));
    ws.on('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });

const mem = (): PairStorage & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
type Stored = { c: string; s: string; k: string; sc: string; wv?: 2; sn?: string };
const stored = (s: { m: Map<string, string> }) => JSON.parse(s.m.get(KEY)!) as Stored;
/** What 0.9.1 stored: no wv, whatever the wallet said. */
const asV091 = (s: { m: Map<string, string> }) => {
  const p = stored(s);
  delete p.wv;
  s.m.set(KEY, JSON.stringify(p));
};
const qrDigest = async (p: Stored) => claimDigest(await walletClaimFor(p.c, PrivateKey.fromHex(p.s).toPublicKey().toString()));
const sessionDigest = (p: Stored) => claimDigest(sessionWalletClaim(PrivateKey.fromHex(p.s), p.k, p.c));
const call = (w: PairedWallet) =>
  Promise.race([
    w.getVersion({}).then(
      () => 'answered',
      (e: Error) => `failed: ${e.message}`,
    ),
    tick(4000).then(() => 'no answer'),
  ]);

/**
 * A phone, as bWalletX 5.2.61 does it (`v2`): first join with the QR claim plus `nc` (its session claim's digest); a
 * rejoin tries its held claim, then the session claim, then the QR claim, always with `nc`; a relay `wcv: 2` makes the
 * session claim the held one; every ready names `nc`. Without `v2`: a build from before wallet claim v2 (QR claim, no
 * `nc`, plain ready).
 */
class Phone {
  P = PrivateKey.fromRandom();
  sealer!: Sealer;
  session!: string;
  qr!: string;
  held!: string;
  wcv?: 2;
  ws: WebSocket | null = null;
  closedWith?: string;
  answered = 0;
  private next = 0;
  constructor(
    public link: PairLink,
    public v2: boolean,
  ) {}

  async init() {
    this.sealer = new Sealer((await deriveSession(this.P, this.link.k, this.link.c)).key, 'wallet');
    this.session = sessionWalletClaim(this.P, this.link.k, this.link.c);
    this.qr = await walletClaimFor(this.link.c, this.link.k);
  }

  private hello() {
    return JSON.stringify({ t: 'hello', k: this.P.toPublicKey().toString(), info: { name: 'sim', rdns: 'space.bwallet.mobile' }, ...(this.wcv && { wcv: 2 }) });
  }
  private async ready() {
    const r: PairMessage = this.v2 ? { t: 'ready', wcv: 2, nc: await claimDigest(this.session) } : { t: 'ready' };
    this.ws!.send(JSON.stringify(await this.sealer.seal(r)));
  }

  /** Open with `claim`; resolves the relay's first frame (verifiedOrigin), or rejects with the refusal's status. */
  private open(claim: string) {
    return new Promise<{ ws: WebSocket; wcv?: number }>((resolve, reject) => {
      void (async () => {
        const nc = this.v2 ? await claimDigest(this.session) : undefined;
        const ws = new WebSocket(routed(relaySocketUrl(this.link.r, this.link.c, 'wallet', undefined, claim, nc)));
        cleanups.push(() => ws.terminate());
        ws.on('unexpected-response', (_q, r) => reject(new Error(String(r.statusCode))));
        ws.on('error', (e) => reject(e));
        ws.on('close', (code, reason) => {
          if (this.ws === ws) this.closedWith = `${code} ${reason}`;
        });
        let first = true;
        ws.on('message', async (d) => {
          const f = JSON.parse(d.toString());
          if (first && f.t === 'relay' && f.verifiedOrigin) {
            first = false;
            resolve({ ws, wcv: f.wcv });
            return;
          }
          await this.serve(ws, f);
        });
      })();
    });
  }

  private async serve(ws: WebSocket, f: { t?: string; peer?: string; role?: string }) {
    if (ws !== this.ws) return;
    // The site came back: hello and ready again (sessions.ts attach).
    if (f.t === 'relay' && f.peer === 'joined' && f.role === 'site') {
      ws.send(this.hello());
      return this.ready();
    }
    if (!isSealed(f)) return;
    const m = await this.sealer.open(f);
    if (m?.t !== 'req') return;
    this.answered++;
    ws.send(JSON.stringify(await this.sealer.seal({ t: 'res', id: m.id, result: { version: 'sim-1' } })));
  }

  /** Scan and Connect: the first join. */
  async pair() {
    const { ws, wcv } = await this.open(this.qr);
    this.ws = ws;
    const bound = this.v2 && wcv === 2;
    // v2: the QR claim is spent at the relay; rejoin with the session claim. An older relay kept the QR claim.
    this.held = bound ? this.session : this.qr;
    this.wcv = bound ? 2 : undefined;
    ws.send(this.hello());
    await this.ready();
  }

  /** Reconnect after the socket was lost. Returns the claim that got in ('session' | 'qr'), or null. */
  async rejoin(): Promise<'session' | 'qr' | null> {
    const candidates = this.v2 ? [...new Set([this.held, this.session, this.qr])] : [this.held];
    for (let i = 0; i < candidates.length; i++) {
      const claim = candidates[this.next % candidates.length];
      try {
        const { ws, wcv } = await this.open(claim);
        this.ws = ws;
        this.closedWith = undefined;
        // A v1 session the relay now holds by the session claim keeps that claim from now on (onUpgradeAnswer).
        if (this.v2 && this.wcv !== 2 && wcv === 2) {
          this.held = this.session;
          this.wcv = 2;
        } else this.held = claim;
        await this.ready();
        return claim === this.session ? 'session' : 'qr';
      } catch {
        this.next++; // refused: the next connect brings the next candidate
      }
    }
    return null;
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

async function pairOnce(v2: boolean) {
  const storage = mem();
  let phone: Phone | null = null;
  const wallet = await pairBwalletX({
    relay: RELAY,
    origin: ORIGIN,
    storage,
    returnStorage: null,
    socket: siteSocket,
    callTimeoutMs: 5000,
    onCode: () => {},
    onLink: (l) =>
      void (async () => {
        const p = new Phone(parsePairUrl(l), v2);
        await p.init();
        phone = p;
        await p.pair();
      })(),
  });
  cleanups.push(() => wallet.close());
  return { wallet, phone: phone! as Phone, storage };
}
const restore = async (storage: PairStorage, socket = siteSocket) => {
  const w = (await restorePairing({ storage, socket, callTimeoutMs: 5000 }))!;
  cleanups.push(() => w.close());
  return w;
};
/** Someone who saw the QR (the channel and the site's key are in it) joins as the wallet, with a session claim of their own. */
const qrHolderJoins = async (p: Stored) =>
  tryOpen(relaySocketUrl(RELAY, p.c, 'wallet', undefined, await walletClaimFor(p.c, PrivateKey.fromHex(p.s).toPublicKey().toString()), 'e'.repeat(64)));

describe('real relay after the legacy cutoff (legacyUntil: 0)', () => {
  it('A: a v2 pairing re-creates a channel the relay dropped after 31 idle days, bound to the session claim', async () => {
    const { relay } = await boot();
    const { wallet, phone, storage } = await pairOnce(true);
    const p = stored(storage);
    expect(p.wv).toBe(2);
    expect(await call(wallet)).toBe('answered');
    wallet.close();
    phone.close();
    // The relay's paired idle window (31 days) passes: the channel is gone.
    offset = 32 * DAY;
    relay._sweep();
    offset = 0;
    expect(relay.stats().channels).toBe(0);
    // What 0.9.1 sends (no wc) is refused after the cutoff: that is the bug this release fixes.
    expect(await tryOpen(relaySocketUrl(RELAY, p.c, 'site', Math.floor(Date.now() / 1000) + 100, p.sc), ORIGIN)).toBe(403);

    siteUrls.length = 0;
    const w2 = await restore(storage);
    const answered = call(w2);
    await until(() => relay.stats().channels === 1);
    expect(siteUrls).toHaveLength(1);
    expect(siteUrls[0].get('wc')).toBe(await sessionDigest(p));
    expect(siteUrls[0].get('claim')).toBe(p.sc);
    expect(await phone.rejoin()).toBe('session');
    expect(await answered).toBe('answered');
    // Bound to the phone's session claim: the QR claim admits nobody.
    expect(await qrHolderJoins(p)).toBe(403);
    expect(phone.closedWith).toBeUndefined();
  });

  it('B: a 0.9.1-stored pairing (no wv) and a 5.2.61 phone, after a lost state file: QR digest once, then v2', async () => {
    await boot();
    const { wallet, phone, storage } = await pairOnce(true);
    asV091(storage);
    const p = stored(storage);
    wallet.close();
    phone.close();
    // The relay restarts without its state file: a new, empty relay.
    const { relay } = await boot();

    siteUrls.length = 0;
    const w2 = await restore(storage);
    const answered = call(w2);
    await until(() => relay.stats().channels === 1);
    // Opened without wc first (refused: no such channel), then once with the QR digest under a fresh site claim.
    expect(siteUrls).toHaveLength(2);
    expect(siteUrls[0].get('wc')).toBeNull();
    expect(siteUrls[0].get('claim')).toBe(p.sc);
    expect(siteUrls[1].get('wc')).toBe(await qrDigest(p));
    expect(siteUrls[1].get('claim')).not.toBe(p.sc);
    // The phone held its session claim (the old relay bound it): refused, then the QR claim gets in and binds nc.
    expect(await phone.rejoin()).toBe('qr');
    expect(phone.wcv).toBe(2);
    expect(await answered).toBe('answered');
    // Its sealed ready named the session claim: the site upgraded, and keeps the new site claim.
    await until(() => stored(storage).wv === 2);
    expect(stored(storage).sc).toBe(siteUrls[1].get('claim'));
    expect(await qrHolderJoins(p)).toBe(403);

    // From now on the site names the session claim: on this live channel that changes nothing.
    w2.close();
    siteUrls.length = 0;
    const w3 = await restore(storage);
    expect(await call(w3)).toBe('answered');
    expect(siteUrls).toHaveLength(1);
    expect(siteUrls[0].get('wc')).toBe(await sessionDigest(p));
    expect(phone.closedWith).toBeUndefined();
    expect(await qrHolderJoins(p)).toBe(403);
  });

  it('C: a v1-stored pairing reconnecting to a live channel never re-binds it to the QR digest', async () => {
    await boot();
    const { wallet, phone, storage } = await pairOnce(true);
    asV091(storage);
    const p = stored(storage);
    wallet.close(); // the phone stays connected; the channel is live and bound to its session claim

    siteUrls.length = 0;
    const w2 = await restore(storage);
    expect(await call(w2)).toBe('answered');
    expect(siteUrls).toHaveLength(1);
    expect(siteUrls[0].get('wc')).toBeNull();
    // The phone's ready (said when the site rejoined) upgrades the pairing.
    await until(() => stored(storage).wv === 2);
    offset = 10 * 60_000; // the QR expired long ago
    expect(await qrHolderJoins(p)).toBe(403);
    await tick(50);
    expect(phone.closedWith).toBeUndefined();
    expect(phone.ws?.readyState).toBe(WebSocket.OPEN);
    expect(await call(w2)).toBe('answered');
  });

  it('C: a reopen that fails for another reason retries under a fresh site claim, which the relay refuses (no re-bind)', async () => {
    await boot();
    const { wallet, phone, storage } = await pairOnce(true);
    asV091(storage);
    const p = stored(storage);
    wallet.close();
    // The first site socket can't reach the relay (a network blip): it is NOT a missing channel.
    let blip = true;
    const flaky = (url: string): SocketLike => {
      if (!blip) return siteSocket(url);
      blip = false;
      siteUrls.push(new URL(url).searchParams);
      const ws = new WebSocket('ws://127.0.0.1:1/', { origin: ORIGIN });
      ws.on('error', () => {});
      return ws as unknown as SocketLike;
    };
    siteUrls.length = 0;
    const w2 = await restore(storage, flaky);
    expect(await call(w2)).toBe('answered');
    // 1: the blip; 2: the QR digest under a fresh claim, refused ('role claimed'); then /health answers, and 3: our claim
    // again, now that the relay is known to answer.
    const ours = siteUrls;
    expect(siteUrls).toHaveLength(3);
    expect(healthChecks).toEqual(['https://relay.test/health']);
    expect(ours.map((q) => q.get('wc'))).toEqual([null, await qrDigest(p), null]);
    expect(ours[1].get('claim')).not.toBe(p.sc);
    expect(ours[2].get('claim')).toBe(p.sc);
    expect(stored(storage).sc).toBe(p.sc); // the refused claim never replaced ours
    expect(stored(storage).sn).toBeUndefined(); // and the pending one went once ours opened
    offset = 10 * 60_000;
    expect(await qrHolderJoins(p)).toBe(403);
    expect(phone.closedWith).toBeUndefined();
  });

  it("C (control): PR #20's reconnect, wc = QR digest on a live channel, does let a QR holder evict the phone", async () => {
    await boot();
    const { wallet, phone, storage } = await pairOnce(true);
    asV091(storage);
    const p = stored(storage);
    wallet.close();
    // What PR #20 sent for a v1 pairing on every reopen. The relay re-binds the session-bound wallet role to it.
    const pr20 = relaySocketUrl(RELAY, p.c, 'site', Math.floor(Date.now() / 1000) + 100, p.sc, await qrDigest(p));
    expect(await tryOpen(pr20, ORIGIN)).toBe('open');
    offset = 10 * 60_000;
    expect(await qrHolderJoins(p)).toBe('open');
    await until(() => !!phone.closedWith);
    expect(phone.closedWith).toBe('4001 replaced');
  });

  it('finding 1: the relay pinned the fresh claim but the page never saw onopen; the pending claim gets back in', async () => {
    await boot();
    const { wallet, phone, storage } = await pairOnce(true);
    asV091(storage);
    const p = stored(storage);
    wallet.close();
    phone.close();
    await boot(); // the channel is lost
    // The socket that re-creates the channel (it carries wc) is accepted by the relay, which pins its site claim, but
    // the page dies before onopen: here, the socket is cut the moment it opens and the page only hears a close.
    let pendingAtOpen: string | undefined;
    const dies = (url: string): SocketLike => {
      if (!new URL(url).searchParams.get('wc')) return siteSocket(url);
      siteUrls.push(new URL(url).searchParams);
      pendingAtOpen = stored(storage).sn;
      const inner = new WebSocket(routed(url), { origin: ORIGIN });
      cleanups.push(() => inner.terminate());
      const s: SocketLike = { readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null, send: () => {}, close: () => inner.terminate() };
      inner.on('error', () => {});
      inner.on('open', () => inner.terminate());
      inner.on('close', () => s.onclose?.({}));
      return s;
    };
    siteUrls.length = 0;
    const w2 = await restore(storage, dies);
    const answered = call(w2);
    await until(() => stored(storage).sc !== p.sc);
    const sn = siteUrls[1].get('claim')!;
    expect(pendingAtOpen).toBe(sn); // saved before the socket opened
    // sc (no such channel) → fresh + QR digest (pinned, never seen open) → /health → sc (role claimed) → the pending
    // claim, WITHOUT wc → open.
    const ours = siteUrls;
    expect(healthChecks).toHaveLength(1);
    expect(ours.map((q) => q.get('claim'))).toEqual([p.sc, sn, p.sc, sn]);
    expect(ours.map((q) => q.get('wc'))).toEqual([null, await qrDigest(p), null, null]);
    expect(stored(storage).sc).toBe(sn);
    expect(stored(storage).sn).toBeUndefined();
    expect(await phone.rejoin()).toBe('qr');
    expect(await answered).toBe('answered');
    expect(await qrHolderJoins(p)).toBe(403);
  });

  it('finding 1: a channel someone else holds: REPAIR_NEEDED, not "Could not reach…" for ever', async () => {
    await boot();
    const { wallet, phone, storage } = await pairOnce(false);
    const p = stored(storage);
    wallet.close();
    phone.close();
    await boot(); // the channel is lost, and a stranger (any client can send an Origin) re-creates it first
    const e = Math.floor(Date.now() / 1000) + 100;
    expect(await tryOpen(relaySocketUrl(RELAY, p.c, 'site', e, 'strangerStrangerStrang', 'd'.repeat(64)), ORIGIN)).toBe('open');
    siteUrls.length = 0;
    const w2 = await restore(storage);
    await expect(w2.getVersion({})).rejects.toMatchObject({ code: 'REPAIR_NEEDED' });
    const n = siteUrls.length;
    await tick(1500);
    expect(siteUrls).toHaveLength(n); // no retry loop
    // Later calls fail at once: no sockets, no /health.
    const checks = healthChecks.length;
    await expect(w2.getVersion({})).rejects.toMatchObject({ code: 'REPAIR_NEEDED' });
    expect(siteUrls).toHaveLength(n);
    expect(healthChecks).toHaveLength(checks);
    expect(stored(storage).sc).toBe(p.sc);
  });

  it('D: an older phone holding the QR claim (no nc) still works, on a live channel and after a lost one', async () => {
    await boot();
    const { wallet, phone, storage } = await pairOnce(false);
    const p = stored(storage);
    expect(p.wv).toBeUndefined();
    expect(await call(wallet)).toBe('answered');
    wallet.close();

    // Live channel: reopened without wc.
    siteUrls.length = 0;
    const w2 = await restore(storage);
    expect(await call(w2)).toBe('answered');
    expect(siteUrls).toHaveLength(1);
    expect(siteUrls[0].get('wc')).toBeNull();
    w2.close();
    phone.close();

    // Lost channel: re-created with the QR digest; the old phone's QR claim gets back in.
    const { relay } = await boot();
    siteUrls.length = 0;
    const w3 = await restore(storage);
    const answered = call(w3);
    await until(() => relay.stats().channels === 1);
    expect(siteUrls.map((q) => q.get('wc'))).toEqual([null, await qrDigest(p)]);
    expect(await phone.rejoin()).toBe('qr');
    expect(await answered).toBe('answered');
    expect(stored(storage).wv).toBeUndefined();
  });
});
