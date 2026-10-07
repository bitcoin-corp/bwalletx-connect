import { PrivateKey, type WalletInterface } from '@bsv/sdk';
import { inOrder } from './in-order.js';
import {
  DEFAULT_RELAY,
  PAIR_VERSION,
  QR_LIFETIME_S,
  Sealer,
  deriveSession,
  isSealed,
  newChannel,
  pairUrl,
  relaySocketUrl,
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
}

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
}

const DEFAULT_KEY = 'bwalletx.connect.pairing.v1';
const OPEN = 1;

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
    // A fresh expiry lets the relay recreate the channel if it was dropped; the wallet rejoins on its own.
    const ws = this.socket(relaySocketUrl(this.p.r, this.p.c, 'site', Math.floor(Date.now() / 1000) + QR_LIFETIME_S - 10));
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
 * Pair with bWalletX on a phone (scan the QR) or web.bwalletx.com (paste the link).
 * Resolves with a wallet once the user taps Connect. The pairing is stored (see `storage`) so
 * `restorePairing()` can reconnect after a reload without a new QR.
 */
export function pairBwalletX(opts: PairingOptions): Promise<PairedWallet> {
  const storage = opts.storage === undefined ? defaultStorage() : (opts.storage ?? memoryStorage());
  const key = opts.storageKey ?? DEFAULT_KEY;
  const socket = opts.socket ?? defaultSocket();
  const relay = opts.relay ?? DEFAULT_RELAY;
  const origin = opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  if (!origin) return Promise.reject(new Error('pairBwalletX needs options.origin outside a browser'));

  const siteKey = PrivateKey.fromRandom(); // a throwaway pairing key, not a wallet key
  const channel = newChannel();
  const expiry = Math.floor(Date.now() / 1000) + QR_LIFETIME_S;

  return new Promise<PairedWallet>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('cancelled'));
    let ws: SocketLike;
    try {
      ws = socket(relaySocketUrl(relay, channel, 'site', expiry));
    } catch (e) {
      return reject(e);
    }
    let sealer: Sealer | null = null;
    let walletKey = '';
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('The pairing code expired. Show a new one.')), QR_LIFETIME_S * 1000);
    opts.signal?.addEventListener('abort', () => fail(new Error('cancelled')));
    ws.onerror = () => fail(new Error('Could not reach the bWalletX pairing service'));
    ws.onclose = () => fail(new Error('The connection to bWalletX closed before pairing finished'));
    ws.onmessage = inOrder(async (ev: { data: unknown }) => {
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
        opts.onCode(s.code);
        return;
      }
      if (!sealer || !isSealed(f)) return;
      const msg = await sealer.open(f);
      if (!msg) return;
      if (msg.t === 'ready') {
        settled = true;
        clearTimeout(timer);
        const p: StoredPairing = { v: 1, c: channel, r: relay, s: siteKey.toHex(), k: walletKey, ...sealer.counters, pairedAt: Date.now() };
        await Promise.resolve(storage.setItem(key, JSON.stringify(p))).catch(() => {});
        const link = new Link(p, sealer, storage, key, socket, opts.callTimeoutMs ?? 120_000);
        link.adopt(ws);
        resolve(link.wallet());
      } else if (msg.t === 'close') {
        fail(new Error('Pairing was declined in bWalletX'));
      }
    });
    opts.onLink(pairUrl({ v: PAIR_VERSION, r: relay, c: channel, k: siteKey.toPublicKey().toString(), o: origin, e: expiry }));
  });
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
