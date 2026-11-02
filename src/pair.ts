import { PrivateKey, type WalletInterface } from '@bsv/sdk';
import { inOrder } from './in-order.js';
import {
  DEFAULT_RELAY,
  PAIR_VERSION,
  QR_LIFETIME_S,
  Sealer,
  deriveSession,
  isSealed,
  claimDigest,
  newChannel,
  newClaim,
  pairUrl,
  relaySocketUrl,
  walletClaimFor,
  type HelloFrame,
  type PairMessage,
} from './protocol.js';

/** localStorage-shaped storage. Methods may be sync or async. */
export interface PairStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** The minimum of the browser WebSocket API this package uses (the `ws` package also fits). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => SocketLike;

export interface PairConnectionOptions {
  /** Where the pairing is kept so it survives a reload. Default: localStorage, else memory only. */
  storage?: PairStorage | null;
  /** Storage key. Default 'bwalletx.connect.pairing.v1'. */
  storageKey?: string;
  /** Opens a socket. Default: the global WebSocket. Pass one to run in Node or to test. */
  socket?: SocketFactory;
  /** Per-call timeout in ms. Default 120000. */
  callTimeoutMs?: number;
}

export interface PairingOptions extends PairConnectionOptions {
  /** Show this link as a QR code, and as text to copy (web.bwalletx.com takes it pasted). */
  onLink: (link: string) => void;
  /** Show this 4-digit code. The wallet shows the same one; the user checks they match. */
  onCode: (code: string) => void;
  signal?: AbortSignal;
  /** Relay host. Default relay.bwallet.space. */
  relay?: string;
  /** This page's origin, as the relay will see it. Default location.origin. */
  origin?: string;
  /**
   * How long (seconds) the wallet has to open the link. Default 120 (QR_LIFETIME_S); clamped to 30–240 (the relay
   * refuses more than 300). Once the wallet has opened it, the user gets at least another 2 minutes to tap Connect.
   */
  lifetimeS?: number;
  /**
   * The round failed (the code expired, the wallet declined, the pairing service was unreachable). Resolve true to
   * start a fresh round (a new link through `onLink`), false to give up with that error. Not called on cancel.
   * pairingModal() shows the error with Try again / Cancel.
   */
  retry?: (err: Error) => Promise<boolean>;
  /** Called once the wallet has connected, before the promise resolves (pairingModal() closes itself here). */
  onPaired?: () => void;
  /** Whether this page is visible, and a way to hear when it is again. Default: the document's visibility. */
  page?: PageLifecycle;
}

/**
 * The page's visibility. On a phone, "Open in bWalletX" leaves the browser for the app, and iOS may kill this page's
 * socket while the user taps Connect there. Pairing rejoins the relay channel when the page is visible again; the
 * relay hands over what the wallet sent meanwhile.
 */
export interface PageLifecycle {
  visible(): boolean;
  /** Call `cb` whenever the page becomes visible again. Returns an unsubscribe. */
  onVisible(cb: () => void): () => void;
}

export const browserPage: PageLifecycle = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onVisible(cb) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
    const on = () => {
      if (document.visibilityState !== 'hidden') cb();
    };
    document.addEventListener('visibilitychange', on);
    window.addEventListener('pageshow', on);
    window.addEventListener('focus', on);
    return () => {
      document.removeEventListener('visibilitychange', on);
      window.removeEventListener('pageshow', on);
      window.removeEventListener('focus', on);
    };
  },
};

/** A BRC-100 wallet whose every call goes, end-to-end encrypted, to the paired phone or web wallet. */
export type PairedWallet = WalletInterface & {
  /** Close the relay connection. The pairing stays stored; the next call reconnects. */
  close(): void;
  /** Tell the wallet to unpair, close, and delete the stored pairing. */
  forget(): Promise<void>;
};

interface StoredPairing {
  v: 1;
  c: string; // channel
  r: string; // relay host
  s: string; // our pairing private key (hex). Random; not a wallet key.
  k: string; // the wallet's pairing public key
  sent: number;
  lastSeen: number;
  pairedAt: number;
  sc?: string; // our relay site claim, sent on every connect. Pairings stored before 0.5.4 get one on reconnect.
}

const DEFAULT_KEY = 'bwalletx.connect.pairing.v1';
const OPEN = 1;
/** After the wallet's hello, the user still has this long to tap Connect (they may be reading the sheet in the app). */
const READY_WINDOW_MS = 120_000;
/** Connected this long after coming back, with nothing from the wallet: the relay has handed over all it held. */
const SETTLE_MS = 3_000;
/** Back on the page but unable to rejoin the relay for this long: give up. */
const REJOIN_GRACE_MS = 15_000;
const REJOIN_MAX_MS = 8_000;

const pairError = (message: string, code: 'EXPIRED' | 'UNREACHABLE' | 'DECLINED' | 'CANCELLED') =>
  Object.assign(new Error(message), { code });
const cancelled = () => pairError('cancelled', 'CANCELLED');

function memoryStorage(): PairStorage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

function defaultStorage(): PairStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* blocked storage */
  }
  return memoryStorage();
}

function defaultSocket(): SocketFactory {
  return (url) => {
    if (typeof WebSocket === 'undefined') throw new Error('No WebSocket here. Pass options.socket.');
    return new WebSocket(url) as unknown as SocketLike;
  };
}

function parseStored(raw: string | null): StoredPairing | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<StoredPairing>;
    const n = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
    if (p.v !== 1) return null;
    if (typeof p.c !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(p.c)) return null;
    if (typeof p.r !== 'string' || !/^[a-z0-9.-]+(:\d+)?$/i.test(p.r)) return null;
    if (typeof p.s !== 'string' || !/^[0-9a-f]{64}$/i.test(p.s)) return null;
    if (typeof p.k !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(p.k)) return null;
    if (!n(p.sent) || !n(p.lastSeen) || !n(p.pairedAt)) return null;
    if (p.sc !== undefined && (typeof p.sc !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/.test(p.sc))) return null;
    return p as StoredPairing;
  } catch {
    return null;
  }
}

class Link {
  private ws: SocketLike | null = null;
  private opening: Promise<void> | null = null;
  private waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private forgotten = false;

  constructor(
    private p: StoredPairing,
    private sealer: Sealer,
    private storage: PairStorage,
    private key: string,
    private socket: SocketFactory,
    private timeoutMs: number,
  ) {}

  /** Take over a socket that is already open (the one pairing used). */
  adopt(ws: SocketLike) {
    this.ws = ws;
    this.wire(ws);
  }

  private wire(ws: SocketLike) {
    ws.onmessage = inOrder((ev: { data: unknown }) => this.onFrame(String(ev.data)));
    ws.onerror = null;
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.failAll(new Error('The connection to bWalletX closed'));
    };
  }

  private persist() {
    if (this.forgotten) return;
    this.p = { ...this.p, ...this.sealer.counters };
    void Promise.resolve(this.storage.setItem(this.key, JSON.stringify(this.p))).catch(() => {});
  }

  private failAll(e: Error) {
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiting.clear();
  }

  private async ensure() {
    if (this.forgotten) throw new Error('This pairing was removed. Pair again.');
    if (this.ws && this.ws.readyState === OPEN) return;
    this.opening ??= this.reopen().finally(() => (this.opening = null));
    await this.opening;
  }

  private reopen() {
    // Pairings stored before site claims get one now; the relay binds it on this connect.
    if (!this.p.sc) {
      this.p = { ...this.p, sc: newClaim() };
      this.persist();
    }
    // A fresh expiry lets the relay recreate the channel if it was dropped; the wallet rejoins on its own.
    const e = Math.floor(Date.now() / 1000) + QR_LIFETIME_S - 10;
    const ws = this.socket(relaySocketUrl(this.p.r, this.p.c, 'site', e, this.p.sc));
    return new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this.ws = ws;
        this.wire(ws);
        resolve();
      };
      ws.onerror = () => reject(new Error('Could not reach the bWalletX pairing service'));
      ws.onclose = () => reject(new Error('Could not reach the bWalletX pairing service'));
    });
  }

  private async onFrame(raw: string) {
    let f: unknown;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    const t = (f as { t?: string; error?: string }).t;
    if (t === 'relay' && (f as { error?: string }).error) {
      return this.failAll(new Error(`bWalletX pairing service: ${(f as { error: string }).error}`));
    }
    if (!isSealed(f)) return;
    const msg = await this.sealer.open(f);
    if (!msg) return;
    this.persist();
    if (msg.t === 'res') {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else w.resolve(msg.result);
    } else if (msg.t === 'close') {
      this.drop();
      this.failAll(new Error('bWalletX disconnected this site. Pair again.'));
    }
  }

  async call(action: string, params: unknown): Promise<unknown> {
    await this.ensure();
    const ws = this.ws!;
    const id = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error('No answer from bWalletX. Open it, unlocked, and approve.'));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
    });
    ws.send(JSON.stringify(await this.sealer.seal({ t: 'req', id, action, params } satisfies PairMessage)));
    this.persist();
    return result;
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private drop() {
    this.forgotten = true;
    void Promise.resolve(this.storage.removeItem(this.key)).catch(() => {});
    this.close();
  }

  async forget() {
    if (this.forgotten) return;
    try {
      if (this.ws && this.ws.readyState === OPEN) {
        this.ws.send(JSON.stringify(await this.sealer.seal({ t: 'close', reason: 'site unpaired' })));
      }
    } catch {
      /* best effort */
    }
    this.drop();
  }

  wallet(): PairedWallet {
    return new Proxy({} as PairedWallet, {
      get: (_t, method) => {
        if (method === 'close') return () => this.close();
        if (method === 'forget') return () => this.forget();
        if (typeof method !== 'string' || method === 'then' || method === 'toJSON') return undefined;
        return (params: unknown) => this.call(method, params ?? {});
      },
    });
  }
}

/**
 * Pair with bWalletX on a phone (scan the QR, or "Open in bWalletX" on the same phone) or web.bwalletx.com (paste
 * the link). Resolves with a wallet once the user taps Connect. The pairing is stored (see `storage`) so
 * `restorePairing()` can reconnect after a reload without a new QR. With `retry`, a failed round can start again.
 */
export async function pairBwalletX(opts: PairingOptions): Promise<PairedWallet> {
  for (;;) {
    try {
      const w = await pairRound(opts);
      opts.onPaired?.();
      return w;
    } catch (e) {
      const err = e as Error & { code?: string };
      if (!opts.retry || opts.signal?.aborted || err.code === 'CANCELLED' || err.message === 'cancelled') throw e;
      const again = await opts.retry(err).catch(() => false);
      if (opts.signal?.aborted) throw cancelled();
      if (!again) throw e;
    }
  }
}

/** One pairing round: one channel, one link. */
function pairRound(opts: PairingOptions): Promise<PairedWallet> {
  const storage = opts.storage === undefined ? defaultStorage() : (opts.storage ?? memoryStorage());
  const key = opts.storageKey ?? DEFAULT_KEY;
  const socket = opts.socket ?? defaultSocket();
  const relay = opts.relay ?? DEFAULT_RELAY;
  const page = opts.page ?? browserPage;
  const origin = opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  if (!origin) return Promise.reject(new Error('pairBwalletX needs options.origin outside a browser'));

  const lifetimeS = Math.min(240, Math.max(30, Math.floor(opts.lifetimeS ?? QR_LIFETIME_S)));
  const siteKey = PrivateKey.fromRandom(); // a throwaway pairing key, not a wallet key
  const channel = newChannel();
  const expiry = Math.floor(Date.now() / 1000) + lifetimeS;
  // b-Aware 26 Oct 2026: our own role claim (N3-1), and the digest of the wallet claim only the QR can produce (N3-2).
  const siteClaim = newClaim();
  const sitePub = siteKey.toPublicKey().toString();

  return walletClaimFor(channel, sitePub).then(claimDigest).then((wc) => new Promise<PairedWallet>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(cancelled());
    const url = relaySocketUrl(relay, channel, 'site', expiry, siteClaim, wc);
    let ws: SocketLike | null = null;
    let sealer: Sealer | null = null;
    let walletKey = '';
    let settled = false;
    let everOpened = false;
    let openedAt = 0;
    let backAt = Date.now();
    let deadline = Date.now() + lifetimeS * 1000;
    let rejoins = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejoinTimer: ReturnType<typeof setTimeout> | null = null;
    let unwatch = () => {};
    const stop = () => {
      clearTimeout(timer);
      if (rejoinTimer) clearTimeout(rejoinTimer);
      unwatch();
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      stop();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      reject(e);
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(check, ms);
    };
    // Past the deadline, give up only once we have heard everything the relay held for us. A page coming back from
    // the app may be resuming a timer that fired while it slept, before its socket has rejoined.
    function check() {
      if (settled) return;
      const now = Date.now();
      if (now < deadline) return arm(deadline - now);
      const expired = () => fail(pairError('The pairing code expired. Show a new one.', 'EXPIRED'));
      if (ws && ws.readyState === OPEN) return now - openedAt >= SETTLE_MS ? expired() : arm(SETTLE_MS - (now - openedAt));
      if (!page.visible()) return arm(SETTLE_MS); // away in the app: decide when the page is back
      if (now - backAt >= REJOIN_GRACE_MS) return expired();
      arm(1_000);
    }
    arm(lifetimeS * 1000);
    opts.signal?.addEventListener('abort', () => fail(cancelled()));

    const onMessage = inOrder(async (ev: { data: unknown }) => {
      if (settled) return;
      let f: unknown;
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if ((f as HelloFrame).t === 'hello' && !sealer) {
        walletKey = (f as HelloFrame).k;
        const s = await deriveSession(siteKey, walletKey, channel);
        sealer = new Sealer(s.key, 'site');
        deadline = Math.max(deadline, Date.now() + READY_WINDOW_MS);
        opts.onCode(s.code);
        return;
      }
      if (!sealer || !isSealed(f)) return;
      const msg = await sealer.open(f);
      if (!msg || settled) return;
      if (msg.t === 'ready') {
        const live = ws;
        if (!live) return;
        settled = true;
        stop();
        const p: StoredPairing = { v: 1, c: channel, r: relay, s: siteKey.toHex(), k: walletKey, ...sealer.counters, pairedAt: Date.now(), sc: siteClaim };
        await Promise.resolve(storage.setItem(key, JSON.stringify(p))).catch(() => {});
        const link = new Link(p, sealer, storage, key, socket, opts.callTimeoutMs ?? 120_000);
        link.adopt(live);
        resolve(link.wallet());
      } else if (msg.t === 'close') {
        fail(pairError('Pairing was declined in bWalletX', 'DECLINED'));
      }
    });

    const unreachable = () => fail(pairError('Could not reach the bWalletX pairing service', 'UNREACHABLE'));
    const rejoinLater = () => {
      if (settled || rejoinTimer || ws) return;
      if (!page.visible()) return; // onVisible rejoins
      const ms = Math.min(500 * 2 ** rejoins++, REJOIN_MAX_MS);
      rejoinTimer = setTimeout(() => {
        rejoinTimer = null;
        if (!ws) join();
      }, ms);
    };
    function join() {
      if (settled) return;
      let s: SocketLike;
      try {
        s = socket(url);
      } catch (e) {
        if (everOpened) return rejoinLater();
        return fail(e as Error);
      }
      ws = s;
      s.onopen = () => {
        everOpened = true;
        openedAt = Date.now();
        rejoins = 0;
      };
      s.onmessage = onMessage;
      // Before the first open this is "unreachable"; after it, onclose follows and we rejoin.
      s.onerror = () => {
        if (!everOpened) unreachable();
      };
      s.onclose = () => {
        if (ws !== s || settled) return;
        ws = null;
        if (!everOpened) return unreachable();
        // Left for the app (or a network blip): rejoin the same channel, now or when the page is visible again.
        rejoinLater();
      };
    }
    unwatch = page.onVisible(() => {
      backAt = Date.now();
      if (!ws && !rejoinTimer) join();
    });
    join();
    opts.onLink(pairUrl({ v: PAIR_VERSION, r: relay, c: channel, k: sitePub, o: origin, e: expiry }));
  }));
}

/**
 * The wallet from a pairing stored by an earlier `pairBwalletX`, or null if there is none.
 * It connects on the first call. The wallet must still have this site paired.
 */
export async function restorePairing(opts: PairConnectionOptions = {}): Promise<PairedWallet | null> {
  const storage = opts.storage === undefined ? defaultStorage() : (opts.storage ?? memoryStorage());
  const key = opts.storageKey ?? DEFAULT_KEY;
  const p = parseStored(await Promise.resolve(storage.getItem(key)).catch(() => null));
  if (!p) return null;
  const { key: aes } = await deriveSession(PrivateKey.fromHex(p.s), p.k, p.c);
  const sealer = new Sealer(aes, 'site');
  sealer.restore({ sent: p.sent, lastSeen: p.lastSeen });
  return new Link(p, sealer, storage, key, opts.socket ?? defaultSocket(), opts.callTimeoutMs ?? 120_000).wallet();
}

/** Delete the stored pairing without telling the wallet. */
export async function clearPairing(opts: Pick<PairConnectionOptions, 'storage' | 'storageKey'> = {}) {
  const storage = opts.storage === undefined ? defaultStorage() : (opts.storage ?? memoryStorage());
  await Promise.resolve(storage.removeItem(opts.storageKey ?? DEFAULT_KEY)).catch(() => {});
}
