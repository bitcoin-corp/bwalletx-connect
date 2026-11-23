import { PrivateKey, Utils, type WalletInterface } from '@bsv/sdk';
import { inOrder } from './in-order.js';
import {
  DEFAULT_RELAY,
  LOGIN_EXPIRY_RE,
  LOGIN_NONCE_RE,
  PAIR_VERSION,
  QR_LIFETIME_S,
  RET_MAX_BYTES,
  RID_RE,
  Sealer,
  deriveSession,
  isSealed,
  claimDigest,
  newChannel,
  newClaim,
  newRequestId,
  pairUrl,
  parseReturnFragment,
  relaySocketUrl,
  sessionWalletClaim,
  walletClaimFor,
  type BrowserHint,
  type HelloFrame,
  type PairMessage,
  type ReadyLogin,
  type SealedFrame,
  browserHint as browserHintFrom,
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
  /**
   * (0.9.0) Subscribe to "the page is back": visible again, pageshow, online, focus, hashchange. Returns an
   * unsubscribe. iOS freezes a tab the user leaves (to open bWalletX) and kills its relay socket; this is when the
   * socket is reopened. Default: those document/window events. Tests pass their own.
   */
  onWake?: (fn: () => void) => () => void;
}

export interface PairingOptions extends PairConnectionOptions {
  /** Show this link as a QR code, and as text to copy (web.bwalletx.com takes it pasted). */
  onLink: (link: string) => void;
  /** Show this 4-digit code. The wallet shows the same one; the user checks they match. */
  onCode: (code: string) => void;
  /** (0.9.0) The wallet tapped Connect. The sign-in (if any) comes next; a modal can say "approve in bWalletX". */
  onPaired?: () => void;
  signal?: AbortSignal;
  /** Relay host. Default relay.bwallet.space. */
  relay?: string;
  /** This page's origin, as the relay will see it. Default location.origin. */
  origin?: string;
  /**
   * (0.9.0) Same phone: the page the sign-in starts on. Must be https on exactly this origin. Only origin + path are
   * kept, in this browser; the link names the origin's root, which bWalletX 5.2.61+ opens after Connect with the
   * result in the fragment; that page calls resumeReturnedPairing(), which gives this page back to go to.
   * pairingModal() sets it on phones and tablets; leave it unset for a QR another device scans.
   */
  returnTo?: string;
  /** (0.9.0) The browser this page runs in (`b`), so the wallet returns to it. Default: from the user agent. */
  browser?: BrowserHint;
  /**
   * (0.9.0) The sign-in challenge to fold into Connect: the wallet asks ONCE ("Connect and sign in") and sends the
   * signature with its ready, so the user isn't sent back to the wallet a second time. `nonce` is the challenge's
   * keyID; `expiresAt` its expiry (ms or ISO). The challenge text must be createChallenge's (loginMessageFor).
   */
  login?: { nonce: string; expiresAt: number | string };
  /** (0.9.0) Where a return tab finds this pairing. Default: localStorage (shared by the tabs of this origin). */
  returnStorage?: PairStorage | null;
  /**
   * (0.9.0) After the wallet says "signed in, see the return" (`ls`), how long to wait for that return before pairing
   * without it (the sign-in then goes as a request, on the wallet's separate sheet). Default 20000 ms.
   */
  returnWaitMs?: number;
  /** (0.9.0) Tests: the current location hash, and how to drop it from the address bar. */
  readHash?: () => string;
  replaceUrl?: (url: string) => void;
}

/** The sign-in a wallet folded into its Connect (0.9.0): ready to post to your verify route. */
export interface FoldedSignIn {
  identityKey: string;
  /** DER signature as number[]. */
  signature: number[];
  nonce: string;
}

/** A BRC-100 wallet whose every call goes, end-to-end encrypted, to the paired phone or web wallet. */
export type PairedWallet = WalletInterface & {
  /** Close the relay connection. The pairing stays stored; the next call reconnects. */
  close(): void;
  /** Tell the wallet to unpair, close, and delete the stored pairing. */
  forget(): Promise<void>;
  /**
   * (0.9.0) Set when the wallet signed the sign-in challenge with Connect (PairingOptions.login). The wallet's
   * getPublicKey({ identityKey: true }) and createSignature for that challenge are then answered here, once, with no
   * second trip to the phone.
   */
  readonly signedIn?: FoldedSignIn;
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
  /**
   * (0.9.2) Wallet claim v2: the wallet's sealed `ready` named its session claim (checked against our own derivation),
   * so every reconnect sends that claim's digest as `wc` and a channel the relay re-creates stays bound to the phone.
   */
  wv?: 2;
  /**
   * (0.9.2) A site claim we are about to rotate to: saved BEFORE the socket that brings it opens, because the relay pins
   * it at the upgrade, and a page that dies before `onopen` would otherwise be left holding a claim the channel no
   * longer accepts. Tried (without `wc`) after `sc`; becomes `sc` once a socket with it opens.
   */
  sn?: string;
}

/** A pairing in progress, saved for the tab the wallet returns to (keyed by the link's one-time `rid`). */
interface PendingReturn {
  v: 1;
  c: string;
  r: string;
  s: string;
  sc: string;
  e: number; // link expiry, seconds
  rid: string;
  ret: string;
  /** The page the pairing started on (origin + path, no query or fragment). Never sent anywhere. */
  page?: string;
  at: number;
  ln?: string;
  /** Set (instead of deleting the entry) when a tab took it, so the other tab knows to stop. */
  taken?: number;
}

const DEFAULT_KEY = 'bwalletx.connect.pairing.v1';
export const RETURN_PREFIX = 'bwalletx.connect.return.';
const RETURN_TTL_MS = 10 * 60 * 1000;
const OPEN = 1;
const CONNECTING = 0;
const RESEND_DEDUPE_MS = 1500;
const REOPEN_MS = 1000;

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

/** visibilitychange (to visible), pageshow, online, focus and hashchange: the moments a frozen tab is back. */
export function onPageWake(fn: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  const vis = () => {
    if (document.visibilityState !== 'hidden') fn();
  };
  const evs = ['pageshow', 'online', 'focus', 'hashchange'] as const;
  document.addEventListener('visibilitychange', vis);
  for (const e of evs) window.addEventListener(e, fn);
  return () => {
    document.removeEventListener('visibilitychange', vis);
    for (const e of evs) window.removeEventListener(e, fn);
  };
}

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * Review 3 (22 Nov 2026): the wallet's return fragment (#bwx=ok&rid=…&wk=…&f=…) leaves the address bar as soon as this
 * module loads, synchronously, and again on every hashchange (this listener is added before any script that loads
 * after connect), so history sync, analytics or session replay never read it. It is kept here, in memory, for
 * resumeReturnedPairing and a waiting pairBwalletX. Load connect before third-party scripts.
 */
let stashedReturn = '';
const isReturnHash = (h: string) => /(^#|&)bwx=ok(&|$)/.test(h);
function stripReturnHash() {
  if (typeof location === 'undefined' || !isReturnHash(location.hash)) return;
  stashedReturn = location.hash;
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  } catch {
    /* no history API: the hash stays */
  }
}
stripReturnHash();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('hashchange', stripReturnHash);
/** (0.9.0) bWalletX's return is waiting to be finished (resumeReturnedPairing). */
export const hasReturnFragment = () => !!stashedReturn;
const defaultHash = () => stashedReturn;
const defaultHref = () => (typeof location !== 'undefined' ? location.href : '');
const defaultReplace = (url: string) => {
  stashedReturn = ''; // taken
  try {
    if (typeof history !== 'undefined') history.replaceState(history.state, '', url);
  } catch {
    /* the hash stays: harmless */
  }
};
const withoutHash = (href: string) => href.split('#')[0];
/** origin + path: no query, no fragment. */
const pageOf = (href: string) => {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
};

/** A return to `ret` is one the wallet will accept for `origin`: https, exactly that origin, no port or userinfo. */
export function isAllowedReturn(ret: string, origin: string): boolean {
  if (!ret || ret.length > RET_MAX_BYTES) return false;
  try {
    const o = new URL(origin);
    const r = new URL(ret);
    if (o.protocol !== 'https:' || r.protocol !== 'https:' || r.username || r.password || r.port || o.port) return false;
    return r.origin === o.origin; // exactly this origin (review 22 Nov 2026: no subdomains)
  } catch {
    return false;
  }
}

const isoExpiry = (x: number | string) => {
  try {
    const iso = new Date(typeof x === 'number' ? x : Date.parse(x)).toISOString();
    return LOGIN_EXPIRY_RE.test(iso) ? iso : null;
  } catch {
    return null;
  }
};

function readPending(store: PairStorage, rid: string): Promise<PendingReturn | null> {
  return Promise.resolve(store.getItem(RETURN_PREFIX + rid))
    .then((raw) => {
      if (!raw) return null;
      const p = JSON.parse(raw) as PendingReturn;
      return p && p.v === 1 && p.rid === rid ? p : null;
    })
    .catch(() => null);
}
const writePending = (store: PairStorage, p: PendingReturn) =>
  Promise.resolve(store.setItem(RETURN_PREFIX + p.rid, JSON.stringify(p))).catch(() => {});
/** Taken (by this tab or another) or expired: the entry holds the site's pairing key, so it goes (review 22 Nov). */
const dropPending = (store: PairStorage, rid: string) => Promise.resolve(store.removeItem(RETURN_PREFIX + rid)).catch(() => {});
/** Remove return entries older than their 10 minutes (and unreadable ones). Needs a store that lists its keys. */
export function pruneReturns(store: PairStorage | null | undefined, now = Date.now()) {
  const s = store as (PairStorage & { key?: (i: number) => string | null; length?: number }) | null | undefined;
  if (!s || typeof s.key !== 'function' || typeof s.length !== 'number') return;
  const keys: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(RETURN_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      let ok = false;
      try {
        const p = JSON.parse(String(s.getItem(k))) as Partial<PendingReturn>;
        ok = typeof p?.at === 'number' && now - p.at <= RETURN_TTL_MS && now >= p.at - 60_000 && !p.taken;
      } catch {
        ok = false;
      }
      if (!ok) s.removeItem(k);
    }
  } catch {
    /* storage blocked */
  }
}

const CLAIM_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** (0.9.2) The code bWalletX itself answers with when a pairing has ended; sites already handle it. */
const REPAIR_NEEDED = 'REPAIR_NEEDED';
const PROBE_MS = 10_000;

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
    if (p.sc !== undefined && (typeof p.sc !== 'string' || !CLAIM_RE.test(p.sc))) return null;
    // Review of #24 (finding 4): an unknown wallet claim version is ignored (treated as v1), not a reason to drop the
    // pairing; so is a malformed pending claim.
    if (p.wv !== undefined && p.wv !== 2) delete p.wv;
    if (p.sn !== undefined && (typeof p.sn !== 'string' || !CLAIM_RE.test(p.sn))) delete p.sn;
    return p as StoredPairing;
  } catch {
    return null;
  }
}

/**
 * (0.9.2) A wallet `ready` with `wcv: 2` names its session claim's digest (`nc`). True only when that matches the claim
 * we derive ourselves from our pairing key and the wallet's. Only ever asked of a SEALED ready: the plaintext hello's
 * `wcv` is never trusted (anyone on the relay path could add it).
 */
async function readySaysV2(msg: PairMessage, mine: PrivateKey, walletKey: string, channel: string): Promise<boolean> {
  if (msg.t !== 'ready' || msg.wcv !== 2 || typeof msg.nc !== 'string') return false;
  try {
    return msg.nc === (await claimDigest(sessionWalletClaim(mine, walletKey, channel)));
  } catch {
    return false;
  }
}

/** The folded sign-in in a ready, checked against the nonce this page asked for. */
function foldedFrom(login: ReadyLogin | undefined, nonce: string | undefined): FoldedSignIn | undefined {
  if (!login || !nonce) return undefined;
  if (typeof login.k !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(login.k)) return undefined;
  if (typeof login.sig !== 'string' || !/^[0-9a-f]{16,200}$/i.test(login.sig) || login.sig.length % 2) return undefined;
  return { identityKey: login.k.toLowerCase(), signature: Utils.toArray(login.sig, 'hex'), nonce };
}

/**
 * Calls that may be asked again with the same id after a reconnect: reads only (review 4, 22 Nov 2026: not even the
 * sign-in signature, which shows a sheet). Everything else is sent once; an unsent call goes out once when the link is
 * back.
 */
const READ_ONLY = new Set([
  'getPublicKey',
  'isAuthenticated',
  'waitForAuthentication',
  'getNetwork',
  'getVersion',
  'getHeight',
  'getHeaderForHeight',
  'listOutputs',
  'listActions',
  'listCertificates',
  'verifySignature',
  'verifyHmac',
  'discoverByIdentityKey',
  'discoverByAttributes',
]);
export function safeToResend(action: string, _params?: unknown): boolean {
  return READ_ONLY.has(action);
}

type Waiting = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  action: string;
  params: unknown;
  /** It reached a socket at least once. An unsent call is sent once when the link is back, spends included. */
  sent: boolean;
};

class Link {
  private ws: SocketLike | null = null;
  private opening: Promise<void> | null = null;
  private waiting = new Map<string, Waiting>();
  private forgotten = false;
  private lastResend = 0;
  private joinTimer: ReturnType<typeof setTimeout> | undefined;
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;
  private unwake: () => void;

  constructor(
    private p: StoredPairing,
    private sealer: Sealer,
    private storage: PairStorage,
    private key: string,
    private socket: SocketFactory,
    private timeoutMs: number,
    wake: (fn: () => void) => () => void,
  ) {
    // iOS froze this tab while the user was in bWalletX and killed its socket: reopen it when the page is back, if a
    // call is still waiting for its answer (the wallet answers again, or the relay held the answer).
    this.unwake = wake(() => {
      if (this.waiting.size) this.revive();
    });
  }

  /** Take over a socket that is already open (the one pairing used). */
  adopt(ws: SocketLike) {
    this.ws = ws;
    this.wire(ws);
  }

  private wire(ws: SocketLike) {
    ws.onmessage = inOrder((ev: { data: unknown }) => this.onFrame(String(ev.data)));
    ws.onerror = null;
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Not an error (0.9.0): on a phone this is the tab going to sleep. Calls keep waiting (each has its timeout);
      // the socket is reopened now if the page is showing, else when it is back.
      if (this.waiting.size && visible()) this.later();
    };
  }

  private later() {
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => this.waiting.size && this.revive(), REOPEN_MS);
  }

  private revive() {
    if (this.forgotten) return;
    const st = this.ws?.readyState;
    if (st === OPEN || st === CONNECTING) return;
    this.ensure().catch(() => {
      if (this.waiting.size && visible()) this.later();
    });
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

  private async reopen() {
    // Another tab of this origin may have rotated the site claim (or learned wv) since we loaded: start from the stored
    // claims when they are this pairing's, so we neither present a stale claim nor write one back over the new one.
    const saved = parseStored(await Promise.resolve(this.storage.getItem(this.key)).catch(() => null));
    if (this.forgotten) throw new Error('This pairing was removed. Pair again.');
    if (saved && saved.c === this.p.c && saved.s === this.p.s && saved.k === this.p.k) {
      const { sn: _sn, ...mine } = this.p;
      this.p = { ...mine, sc: saved.sc ?? this.p.sc, ...(saved.sn && { sn: saved.sn }), ...((saved.wv === 2 || this.p.wv === 2) && { wv: 2 as const }) };
    }
    // Pairings stored before site claims get one now; the relay binds it on this connect.
    if (!this.p.sc) {
      this.p = { ...this.p, sc: newClaim() };
      this.persist();
    }
    const key = PrivateKey.fromHex(this.p.s);
    const v2 = this.p.wv === 2;
    // Wallet claim v2 (0.9.2): always name the session claim's digest. On a live channel already bound to it the relay
    // changes nothing; a channel it lost (31-day idle drop, lost state file) is re-created bound to it, so only the
    // paired phone gets the wallet role. After the relay's legacy cutoff (30 Nov 2026) a channel can't be re-created
    // without `wc` at all.
    // A v1 pairing (stored before 0.9.2, or the wallet never named its session claim) opens WITHOUT `wc`: the QR-bound
    // claim's digest must never reach a live channel, or the relay would re-bind a session-bound wallet role back to it
    // and anyone who saw the QR could then evict the phone.
    const wc = v2 ? await claimDigest(sessionWalletClaim(key, this.p.k, this.p.c)) : undefined;
    const attempt = async (claim: string, withWc?: string) => {
      if (this.forgotten) throw new Error('This pairing was removed. Pair again.');
      try {
        await this.openSite(claim, withWc, () => this.useClaim(claim));
        return true;
      } catch {
        if (this.forgotten) throw new Error('This pairing was removed. Pair again.');
        return false;
      }
    };
    // v1 only: re-create the channel bound to the QR claim, the only wallet claim a v1 pairing knows, under a FRESH site
    // claim. That is safe on a channel that still exists, because of two relay checks (relay.mjs claimOk and attach):
    //  - claimOk refuses a claim the channel doesn't hold when its site claim is held, before `wc` is looked at;
    //  - even where it admits one (a channel opened without a site claim), `wc` moves the wallet binding only for
    //    `siteProven`: the channel's siteBinds AND a site claim the relay ALREADY held, never one pinned by this socket.
    // So the QR digest can only ever open a channel the relay no longer has. The claim is saved as pending (`sn`) BEFORE
    // the socket opens (review of #24, finding 1): the relay pins it at the upgrade, and a page that dies before onopen
    // must still be able to come back with it.
    const fresh = async () => {
      const sn = newClaim();
      this.p = { ...this.p, sn };
      this.persist();
      const qr = await claimDigest(await walletClaimFor(this.p.c, key.toPublicKey().toString()));
      return attempt(sn, qr);
    };

    if (await attempt(this.p.sc!, wc)) return;
    const pending = this.p.sn;
    // A pending claim from a retry whose socket we never saw open: the relay may hold it. Never with `wc`.
    if (pending && (await attempt(pending))) return;
    // No pending claim to lose, so a new one can't strand one the relay pinned.
    if (!v2 && !pending && (await fresh())) return;
    // Everything was refused, or the relay can't be reached: a browser can't tell which (both are a 1006 close). Only a
    // relay that answers makes a refusal mean anything; until then the calls wait and the socket is retried as before.
    if (!(await this.relayAnswers())) throw new Error('Could not reach the bWalletX pairing service');
    if (await attempt(this.p.sc!, wc)) return; // the first refusal may have been a blip
    if (this.p.sn && (await attempt(this.p.sn))) return;
    // The pending claim was refused by a relay that answers, so it holds nothing: a fresh one may replace it.
    if (!v2 && (await fresh())) return;
    // The relay answers and refuses every claim we have: the channel is someone else's now. Say so (the same code
    // bWalletX answers with when a pairing has ended), instead of "Could not reach…" on every retry for ever.
    const err = Object.assign(new Error('This pairing has ended. Pair with bWalletX again.'), { code: REPAIR_NEEDED });
    this.failAll(err);
    throw err;
  }

  /** The claim a socket just opened with is ours from now on; a pending one is no longer needed. */
  private useClaim(claim: string) {
    if (this.p.sc === claim && this.p.sn === undefined) return;
    const { sn: _sn, ...rest } = this.p;
    this.p = { ...rest, sc: claim };
    this.persist();
  }

  /**
   * Does the relay answer at all? Opens a site socket on a new, random channel (it is never used, and the relay drops
   * it within minutes) and closes it. Only asked after every claim was refused.
   */
  private async relayAnswers(): Promise<boolean> {
    const e = Math.floor(Date.now() / 1000) + QR_LIFETIME_S - 10;
    const url = relaySocketUrl(this.p.r, newChannel(), 'site', e, newClaim(), await claimDigest(newClaim()));
    return new Promise<boolean>((resolve) => {
      let ws: SocketLike;
      const done = (ok: boolean) => {
        clearTimeout(timer);
        ws.onopen = ws.onerror = ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        resolve(ok);
      };
      try {
        ws = this.socket(url);
      } catch {
        return resolve(false);
      }
      const timer = setTimeout(() => done(false), PROBE_MS);
      ws.onopen = () => done(true);
      ws.onerror = () => done(false);
      ws.onclose = () => done(false);
    });
  }

  private openSite(sc: string, wc?: string, onOpen?: () => void) {
    // A fresh expiry lets the relay recreate the channel if it was dropped; the wallet rejoins on its own.
    const e = Math.floor(Date.now() / 1000) + QR_LIFETIME_S - 10;
    const ws = this.socket(relaySocketUrl(this.p.r, this.p.c, 'site', e, sc, wc));
    return new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        onOpen?.();
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
    if (t === 'relay') {
      const rf = f as { error?: string; peer?: string; role?: string };
      if (rf.error) return this.failAll(new Error(`bWalletX pairing service: ${rf.error}`));
      // The phone is back. bWalletX follows with a ready; a build that doesn't still gets the resend, once.
      if (rf.peer === 'joined' && rf.role === 'wallet') {
        clearTimeout(this.joinTimer);
        this.joinTimer = setTimeout(() => void this.resend(), RESEND_DEDUPE_MS);
      }
      return;
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
    } else if (msg.t === 'ready') {
      // Said at pairing and again whenever either side rejoins: ask again for anything unanswered, with the SAME ids
      // (bWalletX answers a repeated id from its stored answer; it never runs a request twice).
      clearTimeout(this.joinTimer);
      void this.resend();
      // (0.9.2) A v1 pairing upgrades here: the wallet's sealed ready names its session claim (bWalletX 5.2.61+ does on
      // every rejoin). From now on every reconnect sends its digest as `wc`, which also re-binds the wallet role to it
      // on a channel still bound to the QR claim (the relay accepts that from the site claim that opened the channel).
      if (this.p.wv !== 2 && (await readySaysV2(msg, PrivateKey.fromHex(this.p.s), this.p.k, this.p.c)) && !this.forgotten) {
        this.p = { ...this.p, wv: 2 };
        this.persist();
      }
    } else if (msg.t === 'close') {
      this.drop();
      this.failAll(new Error('bWalletX disconnected this site. Pair again.'));
    }
  }

  private async resend() {
    if (Date.now() - this.lastResend < RESEND_DEDUPE_MS) return;
    this.lastResend = Date.now();
    for (const [id, w] of this.waiting) {
      // Review 22 Nov 2026: only reads are asked again (review 4: not the sign-in either). A spend (or anything that acts) is never
      // re-sent: bWalletX's record of answered ids is in memory, so after iOS kills it a re-sent createAction would
      // show a second payment sheet. It keeps waiting for its own answer, and times out as "maybe sent".
      if (w.sent && !safeToResend(w.action, w.params)) continue;
      const ws = this.ws;
      if (!ws || ws.readyState !== OPEN) return;
      ws.send(JSON.stringify(await this.sealer.seal({ t: 'req', id, action: w.action, params: w.params })));
      w.sent = true;
      this.persist();
    }
  }

  async call(action: string, params: unknown): Promise<unknown> {
    const id = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const w = this.waiting.get(id);
        if (!w || !this.waiting.delete(id)) return;
        if (!w.sent || safeToResend(action, params)) reject(Object.assign(new Error('No answer from bWalletX. Open it, unlocked, and approve.'), { code: 'NO_ANSWER' }));
        else
          reject(
            Object.assign(new Error('No answer from bWalletX. It may still have done this: check bWalletX before you try again.'), {
              code: 'NO_ANSWER_MAYBE_SENT',
            }),
          );
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer, action, params, sent: false });
    });
    try {
      await this.ensure();
      const frame = JSON.stringify(await this.sealer.seal({ t: 'req', id, action, params } satisfies PairMessage));
      this.ws!.send(frame);
      const w = this.waiting.get(id);
      if (w) w.sent = true;
      this.persist();
    } catch (e) {
      // Couldn't send now (the tab is going to sleep, or the relay is unreachable this second): the call waits, and
      // goes out when the socket is back and the wallet says ready. A removed pairing fails at once.
      if (this.forgotten) {
        const w = this.waiting.get(id);
        if (w) {
          clearTimeout(w.timer);
          this.waiting.delete(id);
        }
        throw e;
      }
      if (visible()) this.later();
    }
    return result;
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private drop() {
    this.forgotten = true;
    this.unwake();
    clearTimeout(this.reopenTimer);
    clearTimeout(this.joinTimer);
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

  wallet(signedIn?: FoldedSignIn): PairedWallet {
    let keyGiven = false;
    let sigGiven = false;
    const local = (method: string, params: unknown): Promise<unknown> | null => {
      if (!signedIn) return null;
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === 'getPublicKey' && !keyGiven && p.identityKey === true && !p.protocolID && !p.counterparty) {
        keyGiven = true;
        return Promise.resolve({ publicKey: signedIn.identityKey });
      }
      const proto = p.protocolID as unknown[] | undefined;
      if (
        method === 'createSignature' &&
        !sigGiven &&
        Array.isArray(proto) &&
        proto[0] === 2 &&
        proto[1] === 'bwallet sign in' &&
        p.keyID === signedIn.nonce &&
        p.counterparty === 'anyone'
      ) {
        sigGiven = true;
        return Promise.resolve({ signature: signedIn.signature.slice() });
      }
      return null;
    };
    return new Proxy({} as PairedWallet, {
      get: (_t, method) => {
        if (method === 'close') return () => this.close();
        if (method === 'forget') return () => this.forget();
        if (method === 'signedIn') return signedIn;
        if (typeof method !== 'string' || method === 'then' || method === 'toJSON') return undefined;
        return (params: unknown) => local(method, params) ?? this.call(method, params ?? {});
      },
    });
  }
}

/**
 * Pair with bWalletX on a phone (scan the QR, or open the link on the same phone) or web.bwalletx.com (paste the link).
 * Resolves with a wallet once the user taps Connect. The pairing is stored (see `storage`) so `restorePairing()` can
 * reconnect after a reload without a new QR.
 *
 * 0.9.0: the relay socket dying is not a failure (on a phone it is the tab going to sleep while the user is in
 * bWalletX): it is reopened when the page is back, and the wallet's hello and ready, held by the relay or said again
 * by the wallet, finish the pairing. With `returnTo` the wallet sends the user back here; with `login` the sign-in is
 * signed with Connect.
 */
export function pairBwalletX(opts: PairingOptions): Promise<PairedWallet> {
  const storage = opts.storage === undefined ? defaultStorage() : (opts.storage ?? memoryStorage());
  const returns = opts.returnStorage === undefined ? defaultStorage() : (opts.returnStorage ?? memoryStorage());
  pruneReturns(returns);
  const key = opts.storageKey ?? DEFAULT_KEY;
  const socket = opts.socket ?? defaultSocket();
  const relay = opts.relay ?? DEFAULT_RELAY;
  const origin = opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const wake = opts.onWake ?? onPageWake;
  const readHash = opts.readHash ?? defaultHash;
  const replaceUrl = opts.replaceUrl ?? defaultReplace;
  if (!origin) return Promise.reject(new Error('pairBwalletX needs options.origin outside a browser'));

  const siteKey = PrivateKey.fromRandom(); // a throwaway pairing key, not a wallet key
  const channel = newChannel();
  const expiry = Math.floor(Date.now() / 1000) + QR_LIFETIME_S;
  // b-Aware 26 Oct 2026: our own role claim (N3-1), and the digest of the wallet claim only the QR can produce (N3-2).
  const siteClaim = newClaim();
  const sitePub = siteKey.toPublicKey().toString();
  // Same phone (0.9.0): the one-time id that ties the return to this pairing. Review 22 Nov 2026: the link names only
  // this origin's root (the wallet returns there: a path chosen by an unproven link is not followed), and no query or
  // fragment ever goes into the link (OAuth codes and the like). The page itself is kept here, for after the return.
  const page = opts.returnTo ? pageOf(opts.returnTo) : '';
  const sameDevice = !!page && isAllowedReturn(page, origin);
  const ret = sameDevice ? `${new URL(origin).origin}/` : '';
  const rid = sameDevice ? newRequestId() : undefined;
  const ln = opts.login && LOGIN_NONCE_RE.test(opts.login.nonce) ? opts.login.nonce : undefined;
  const lx = ln ? isoExpiry(opts.login!.expiresAt) ?? undefined : undefined;
  const b: BrowserHint | undefined = sameDevice
    ? opts.browser ??
      (typeof navigator !== 'undefined' ? browserHintOf(navigator) : undefined)
    : undefined;

  return walletClaimFor(channel, sitePub).then(claimDigest).then((wc) => new Promise<PairedWallet>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('cancelled'));
    let ws: SocketLike | null = null;
    let everOpen = false;
    let sealer: Sealer | null = null;
    let walletKey = '';
    let settled = false;
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingSaved = false;
    let returnWait: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(reopenTimer);
      clearTimeout(returnWait);
      unwake();
    };
    const fail = (e: Error) => {
      if (settled) return;
      done();
      const s = ws;
      ws = null;
      s?.close();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('The pairing code expired. Show a new one.')), QR_LIFETIME_S * 1000);
    opts.signal?.addEventListener('abort', () => {
      // Tell the wallet, so its Connect card doesn't stay up after the user closed ours (best effort).
      const s = ws;
      if (!s || !sealer || s.readyState !== OPEN || settled) return fail(new Error('cancelled'));
      void sealer
        .seal({ t: 'close', reason: 'site cancelled' })
        .then((f) => s.send(JSON.stringify(f)))
        .catch(() => undefined)
        .finally(() => fail(new Error('cancelled')));
    });

    // Review 22 Nov 2026: a return fragment is only a CLAIM. Anyone holding the link (it carries the channel, our
    // pairing key and the rid) can seal a `ready` with their own key and sign-in. It counts only once the relay's
    // wallet (the one the relay bound to this channel) says hello with the same key.
    let provisional: { wk: string; f: SealedFrame } | null = null;

    const onHello = async (h: HelloFrame) => {
      if (sealer) return; // said again after a rejoin: we have it
      walletKey = h.k;
      const s = await deriveSession(siteKey, walletKey, channel);
      if (sealer) return;
      sealer = new Sealer(s.key, 'site');
      opts.onCode(s.code);
      const p = provisional;
      provisional = null;
      if (p && p.wk.toLowerCase() === h.k.toLowerCase()) {
        const msg = await sealer.open(p.f);
        if (msg?.t === 'ready') await finish(msg, ws);
      }
    };

    const finish = async (msg: Extract<PairMessage, { t: 'ready' }>, sock: SocketLike | null) => {
      if (settled || !sealer) return;
      if (rid && pendingSaved) {
        // Review 22 Nov 2026: another tab (the wallet's return) may have finished this pairing already: then stop.
        const p = await readPending(returns, rid);
        if (settled) return;
        if (!p || p.taken) return fail(Object.assign(new Error('Signed in from another tab.'), { code: 'RETURNED_IN_ANOTHER_TAB' }));
        await dropPending(returns, rid);
      }
      if (settled) return;
      // (0.9.2) Wallet claim v2: only from the SEALED ready's `nc`, checked against our own derivation.
      const v2 = await readySaysV2(msg, siteKey, walletKey, channel);
      if (settled) return;
      done();
      const p: StoredPairing = { v: 1, c: channel, r: relay, s: siteKey.toHex(), k: walletKey, ...sealer.counters, pairedAt: Date.now(), sc: siteClaim, ...(v2 && { wv: 2 as const }) };
      await Promise.resolve(storage.setItem(key, JSON.stringify(p))).catch(() => {});
      const link = new Link(p, sealer, storage, key, socket, opts.callTimeoutMs ?? 120_000, wake);
      if (sock && sock.readyState === OPEN) link.adopt(sock);
      else sock?.close();
      try {
        opts.onPaired?.();
      } catch {
        /* UI only */
      }
      resolve(link.wallet(foldedFrom(msg.login, ln)));
    };

    // The wallet signed in with Connect and sends the signature in its return (the fragment), not over the relay. Wait
    // for that return (takeHash, or a new tab); if none comes, pair without it and the sign-in goes as a request.
    const onSignedInSeeReturn = async (msg: Extract<PairMessage, { t: 'ready' }>, sock: SocketLike) => {
      if (pendingSaved && rid && !(await readPending(returns, rid)))
        return fail(Object.assign(new Error('Signed in from another tab.'), { code: 'RETURNED_IN_ANOTHER_TAB' }));
      if (await takeHash()) return;
      clearTimeout(returnWait);
      returnWait = setTimeout(() => {
        if (!settled) void finish(msg, ws ?? sock);
      }, opts.returnWaitMs ?? 20_000);
    };

    const handler = (sock: SocketLike) =>
      inOrder(async (ev: { data: unknown }) => {
        if (settled || sock !== ws) return;
        let f: unknown;
        try {
          f = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if ((f as HelloFrame).t === 'hello' && typeof (f as HelloFrame).k === 'string') return onHello(f as HelloFrame);
        if (!sealer || !isSealed(f)) return;
        const msg = await sealer.open(f);
        if (!msg) return;
        if (msg.t === 'ready') {
          // CTO 22 Nov 2026: a sign-in signature never counts when it came over the relay (a script that opened this
          // channel could be reading it). It comes only in the return fragment, in this browser.
          const relayed = { ...msg, login: undefined };
          if (msg.ls && rid) await onSignedInSeeReturn(relayed, sock);
          else await finish(relayed, sock);
        } else if (msg.t === 'close') fail(new Error('Pairing was declined in bWalletX'));
      });

    const open = (first: boolean) => {
      let s: SocketLike;
      try {
        // The first connect opens the channel (with `wc`); later ones rejoin it with our claim.
        s = socket(relaySocketUrl(relay, channel, 'site', expiry, siteClaim, first ? wc : undefined));
      } catch (e) {
        if (first) return fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      ws = s;
      s.onopen = () => {
        everOpen = true;
      };
      s.onmessage = handler(s);
      s.onerror = null;
      s.onclose = () => {
        if (settled || ws !== s) return;
        ws = null;
        if (!everOpen) return fail(new Error('Could not reach the bWalletX pairing service'));
        // 0.9.0: not a failure. On a phone the tab went to sleep while the user is in bWalletX; rejoin now if the
        // page is showing, else when it is back (the relay holds the wallet's frames meanwhile, and the wallet says
        // hello and ready again when we rejoin).
        if (visible()) {
          clearTimeout(reopenTimer);
          reopenTimer = setTimeout(revive, REOPEN_MS);
        }
      };
    };

    // The wallet sent the user back to this same tab (a hash change, or the page shown again with the hash).
    const takeHash = async () => {
      const frag = rid ? parseReturnFragment(readHash()) : null;
      if (!frag || frag.rid !== rid) return false;
      replaceUrl(withoutHash(defaultHref()) || ret);
      if (!frag.f || !frag.wk) return false; // an older wallet: the relay carries hello and ready
      if (!sealer) {
        // Not confirmed yet: kept until the relay's wallet says hello with this key (onHello), never used before.
        provisional = { wk: frag.wk, f: frag.f };
        return false;
      }
      if (walletKey.toLowerCase() !== frag.wk.toLowerCase()) return false; // not the wallet the relay bound: ignored
      const msg = await sealer.open(frag.f);
      if (msg?.t === 'ready') {
        await finish(msg, ws);
        return true;
      }
      return false;
    };

    const revive = async () => {
      if (settled) return;
      if (rid) {
        // Another tab (the wallet's return opened a new one) took this pairing: stop, don't fight it for the relay.
        const p = pendingSaved ? await readPending(returns, rid) : null;
        if (pendingSaved && (!p || p.taken))
          return fail(Object.assign(new Error('Signed in from another tab.'), { code: 'RETURNED_IN_ANOTHER_TAB' }));
        if (await takeHash()) return;
      }
      if (settled) return;
      const st = ws?.readyState;
      if (st === OPEN || st === CONNECTING) return;
      open(false);
    };
    const unwake = wake(() => void revive());

    open(true);
    const link = pairUrl({
      v: PAIR_VERSION,
      r: relay,
      c: channel,
      k: sitePub,
      o: origin,
      e: expiry,
      ...(sameDevice && rid && { ret, rid, ...(b && { b }) }),
      ...(ln && lx && { ln, lx }),
    });
    if (rid)
      void writePending(returns, { v: 1, c: channel, r: relay, s: siteKey.toHex(), sc: siteClaim, e: expiry, rid, ret, page, at: Date.now(), ...(ln && { ln }) })
        .then(() => readPending(returns, rid))
        .then((p) => {
          pendingSaved = !!p; // only an entry we know was written can later say "taken" by its absence
        });
    opts.onLink(link);
  }));
}

function browserHintOf(nav: Navigator): BrowserHint {
  return browserHintFrom(nav.userAgent ?? '', !!(nav as { brave?: unknown }).brave);
}

export interface ResumeOptions extends PairConnectionOptions {
  returnStorage?: PairStorage | null;
  /** Tests: the location's hash and href, and how to drop the hash from the address bar. */
  hash?: string;
  href?: string;
  replaceUrl?: (url: string) => void;
  /** How long to wait for the relay when the fragment has no frame (an older wallet). Default 30000 ms. */
  waitMs?: number;
}

export interface ResumedPairing {
  wallet: PairedWallet;
  /** The sign-in signed with Connect: post it to your verify route. null when the wallet didn't fold one. */
  login: FoldedSignIn | null;
  /**
   * The page the sign-in started on (origin + path, from this browser's own storage; the wallet returns to the root).
   * Go there after verifying, if it isn't where you are.
   */
  page: string | null;
}

/**
 * (0.9.0) Call on page load. bWalletX sent the user back to `<page>#bwx=ok&rid=…` after Connect (on iOS and Android
 * that is a NEW tab): if this browser saved that pairing, finish it here and return the wallet and the folded
 * sign-in; post `login` to your verify route. The hash is removed either way. Resolves null when there is nothing to
 * resume (no fragment, an unknown or used rid, or an expired one). BwalletXProvider and <bwalletx-signin> do this.
 */
export async function resumeReturnedPairing(opts: ResumeOptions = {}): Promise<ResumedPairing | null> {
  const hash = opts.hash ?? defaultHash();
  const frag = parseReturnFragment(hash);
  if (!frag) return null;
  const href = opts.href ?? defaultHref();
  (opts.replaceUrl ?? defaultReplace)(withoutHash(href));
  const returns = opts.returnStorage === undefined ? defaultStorage() : (opts.returnStorage ?? memoryStorage());
  pruneReturns(returns);
  const p = await readPending(returns, frag.rid);
  if (!p || p.taken || Date.now() - p.at > RETURN_TTL_MS || !RID_RE.test(p.rid)) return null;
  const storage = opts.storage === undefined ? defaultStorage() : (opts.storage ?? memoryStorage());
  const key = opts.storageKey ?? DEFAULT_KEY;
  const socket = opts.socket ?? defaultSocket();
  const S = PrivateKey.fromHex(p.s);

  type Got = { sealer: Sealer; wk: string; msg: Extract<PairMessage, { t: 'ready' }> };
  // The fragment's sealed ready (bWalletX 5.2.61+) is PROVISIONAL (review 22 Nov 2026): anyone holding the link can
  // forge one with their own key. It is used only once the relay's wallet says hello with the same key, or a frame
  // from the relay opens under it. Without a fragment, hello and ready come from the relay alone.
  let pending: Got | null = null;
  if (frag.wk && frag.f) {
    const { key: aes } = await deriveSession(S, frag.wk, p.c);
    const sealer = new Sealer(aes, 'site');
    const msg = await sealer.open(frag.f);
    if (msg?.t === 'ready') pending = { sealer, wk: frag.wk, msg };
  }
  const got = await new Promise<Got | null>((resolve) => {
    let sealer: Sealer | null = null;
    let wk = '';
    let over = false;
    const ws = socket(relaySocketUrl(p.r, p.c, 'site', undefined, p.sc));
    const end = (v: Got | null) => {
      if (over) return;
      over = true;
      clearTimeout(t);
      ws.onclose = null;
      ws.close();
      resolve(v);
    };
    const t = setTimeout(() => end(null), opts.waitMs ?? 30_000);
    ws.onclose = () => end(null);
    ws.onerror = null;
    ws.onmessage = inOrder(async (ev: { data: unknown }) => {
      let f: unknown;
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if ((f as HelloFrame).t === 'hello' && typeof (f as HelloFrame).k === 'string' && !sealer) {
        wk = (f as HelloFrame).k;
        // The relay's wallet confirms the fragment: same key.
        if (pending && pending.wk.toLowerCase() === wk.toLowerCase()) return end(pending);
        pending = null; // a different key: the fragment was not from the relay's wallet
        sealer = new Sealer((await deriveSession(S, wk, p.c)).key, 'site');
        return;
      }
      if (!isSealed(f)) return;
      if (pending && (await pending.sealer.open(f))) return end(pending); // a relay frame under the fragment's key
      if (!sealer) return;
      const msg = await sealer.open(f);
      // Over the relay: never a sign-in signature (CTO 22 Nov 2026), only "paired".
      if (msg?.t === 'ready') end({ sealer, wk, msg: { ...msg, login: undefined } });
    });
  });
  if (!got) return null;
  // Taken only once confirmed, so a forged or unconfirmed fragment never stops the tab that started the pairing.
  const again = await readPending(returns, frag.rid);
  if (!again || again.taken) return null;
  await dropPending(returns, frag.rid); // taken: the entry (it holds the site's pairing key) goes
  // (0.9.2) Wallet claim v2: only from the sealed ready's `nc` (the fragment's or the relay's), checked against our own.
  const v2 = await readySaysV2(got.msg, S, got.wk, p.c);
  const stored: StoredPairing = { v: 1, c: p.c, r: p.r, s: p.s, k: got.wk, ...got.sealer.counters, pairedAt: Date.now(), sc: p.sc, ...(v2 && { wv: 2 as const }) };
  await Promise.resolve(storage.setItem(key, JSON.stringify(stored))).catch(() => {});
  const login = foldedFrom(got.msg.login, p.ln) ?? null;
  const link = new Link(stored, got.sealer, storage, key, socket, opts.callTimeoutMs ?? 120_000, opts.onWake ?? onPageWake);
  return { wallet: link.wallet(login ?? undefined), login, page: p.page && isAllowedReturn(p.page, new URL(href || p.page).origin) ? p.page : null };
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
  return new Link(p, sealer, storage, key, opts.socket ?? defaultSocket(), opts.callTimeoutMs ?? 120_000, opts.onWake ?? onPageWake).wallet();
}

/** Delete the stored pairing without telling the wallet. */
export async function clearPairing(opts: Pick<PairConnectionOptions, 'storage' | 'storageKey'> = {}) {
  const storage = opts.storage === undefined ? defaultStorage() : (opts.storage ?? memoryStorage());
  await Promise.resolve(storage.removeItem(opts.storageKey ?? DEFAULT_KEY)).catch(() => {});
}
