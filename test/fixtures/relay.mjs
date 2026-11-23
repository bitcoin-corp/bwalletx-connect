// FIXTURE: a verbatim copy of the bWalletX pairing relay, for test/relay-interop.test.ts. Not shipped (not in `files`).
// Source: bWalletX relay/relay.mjs at commit c4076133 (in bitcoin-corp main and the `bwallet` release branch; the relay
// shipped with bWalletX 5.2.61), sha256 of the original 2deca881ebc569e8c418124ec5f59a84028c63d769dee217d96816fd3e38f452.
// Only these comment lines are added. Refresh it when the relay's claim rules change, and keep the tests passing.
/**
 * bWallet phone-pairing relay (tokenblaster.lol docs/wallet-connect.md §4).
 *
 * Two websockets per channel: the site (desktop page) and the wallet (bWallet on a phone). The relay
 * forwards their frames verbatim. Frames after the hello are end-to-end encrypted, so it can't read or
 * change them. It logs counts only. With a state file (createRelay({ stateFile }), RELAY_STATE_FILE) it keeps each
 * paired channel's origin and claim digests across restarts, never frames, keys or addresses.
 *
 * It ties the channel to the site socket's Origin header and tells the phone ({ t: 'relay', verifiedOrigin }).
 * Browsers set that header and page scripts can't change it, but any non-browser client can send whatever it
 * likes, so it is only a hint: it stops a QR shown on a phishing page in a real browser, nothing more. Never treat
 * it as proof of who is on the other end (audit C2); protocols that send secrets must authenticate the peer
 * themselves (e.g. "open on computer" makes the computer prove a code shown only on the phone).
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { open as openFile, rename, unlink } from 'node:fs/promises';
import { WebSocketServer } from 'ws';

export const LIMITS = {
  maxFrame: 4 * 1024 * 1024, // large transaction bundles
  framesPerMinute: 60,
  channelsPerIp: 1000,
  queueFrames: 20,
  queueMs: 60_000,
  maxQrLifetimeS: 300,
  unpairedIdleMs: 2 * 60_000,
  pairedIdleMs: 31 * 24 * 60 * 60_000, // CLI pairings last up to 30 days
  stateChannels: 50_000, // most channels kept in the state file (the most recently active)
};

const CHANNEL = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url
const ROLES = new Set(['site', 'wallet']);
// Optional per-role claim secret (b-Aware, 24 Oct 2026): the first socket that brings one owns the role; later
// sockets for that role must bring the same one, so a stranger who knows the channel ID can't take it over.
const CLAIM = /^[A-Za-z0-9_-]{22,64}$/;
const claimHash = (c) => createHash('sha256').update(c).digest('hex');
// b-Aware 26 Oct 2026 (N3-1/N3-2): a new site sends `wc`, the SHA-256 (hex) of the wallet claim that only the QR
// can produce (protocol walletClaimFor(channel, site pubkey)). The relay never sees the QR, so someone who only
// knows the channel ID can't make that claim, and a wallet that brings it always wins the role.
const CLAIM_DIGEST = /^[0-9a-f]{64}$/;
// Session-bound wallet claim (wallet claim v2, 12 Nov 2026). The QR-bound claim above is computable by anyone who sees
// the QR, so it is good for the first join only. A v2 wallet joins with it plus `nc`, the SHA-256 (hex) of its session
// claim: an HMAC keyed by the ECDH secret of its own pairing key and the site's, which only the two ends can compute.
// The relay then binds the wallet role to `nc` and the QR claim stops admitting anyone. Sites that know the pairing
// is v2 send that same digest as `wc` whenever they reconnect, so a re-created channel stays bound to the phone.
export const WALLET_CLAIM_V2 = 2;

/**
 * From this moment a wallet that takes an unclaimed wallet role must bring `nc` (wallets from before wallet claim v2
 * are refused and have to update). Default: not enforced; set RELAY_SESSION_CLAIMS_FROM (ISO date) or
 * createRelay({ sessionClaimsFrom }) in ms once the wallet release that sends `nc` is out.
 */
export const SESSION_CLAIMS_FROM = Infinity;

/**
 * Compatibility window for clients from before 26 Oct 2026 (sites without a site claim or `wc`, wallets with a random
 * claim). Until this moment the relay still opens a new channel for a site with no claim or no `wc`, and still lets the
 * first wallet claim win on a channel without a QR-bound one. After it, all of these are refused: a new channel needs a
 * site claim and `wc`, and the wallet role is never first-come (b-Aware triage 13 Nov 2026). Override with
 * RELAY_LEGACY_CLAIMS_UNTIL (ISO date) or createRelay({ legacyUntil }) in ms.
 */
export const LEGACY_CLAIMS_UNTIL = Date.parse('2026-11-30T00:00:00Z');

/**
 * Proxies whose x-real-ip we believe (audit N3-obs). Anyone else could send the header to dodge the per-IP limit, so
 * a direct connection is counted by its socket address. Default: loopback (nginx on the same box).
 */
export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** The client's address: x-real-ip only when the socket comes from a trusted proxy. */
export function clientIp(req, trusted = DEFAULT_TRUSTED_PROXIES) {
  const peer = (req.socket?.remoteAddress || '').toString();
  const real = req.headers['x-real-ip'];
  if (real && trusted.includes(peer)) return String(Array.isArray(real) ? real[0] : real).trim();
  return peer;
}
const other = (role) => (role === 'site' ? 'wallet' : 'site');

/** True for an https origin, or http on localhost (local development). */
export function acceptableOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.origin !== origin) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch {
    return false;
  }
}

export function createRelay({
  server,
  now = () => Date.now(),
  log = () => {},
  legacyUntil = LEGACY_CLAIMS_UNTIL,
  sessionClaimsFrom = SESSION_CLAIMS_FROM,
  trustedProxies = DEFAULT_TRUSTED_PROXIES,
  stateFile = null,
  stateWriteMs = 1000,
} = {}) {
  const legacy = () => now() < legacyUntil;
  const sessionClaimsRequired = () => now() >= sessionClaimsFrom;
  const channels = new Map();
  const perIp = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrame });
  let closed = false;

  const send = (ws, obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

  const newChannel = (c) => ({
    site: null,
    wallet: null,
    queue: { site: [], wallet: [] },
    rate: { start: c.lastActive, n: 0 },
    savedAt: c.lastActive,
    // True when the site claim was brought by the socket that opened the channel (or restored as such): only that
    // claim may move the wallet binding. A claim pinned later, on a channel opened without one, holds the site role only.
    siteBinds: false,
    // True when the wallet role went to the first wallet that came (no `wc`, nobody holding it), which only the
    // compatibility window allows. After the window such a channel lives only while in use (unpaired idle limit) and is
    // not kept across restarts, until its site proves its claim and re-binds the wallet role with `wc`.
    legacyWallet: false,
    ...c,
  });

  // Paired channels survive a restart (review 13 Nov 2026): without this, whoever opened the site role first after a
  // restart re-created the channel with their own origin and claims, locking the real site out and unpairing the
  // phone. Kept per channel: origin, the site and wallet claim digests, the wallet binding, whether the site claim may
  // re-bind the wallet (`sb`) and the last activity (for the paired idle window). Only channels with both a site claim
  // and a wallet binding are kept (nothing else is worth defending), at most LIMITS.stateChannels, most recent first.
  // No addresses are kept, so a restored channel counts against no one's per-IP limit: a restart resets that quota,
  // bounded by the cap above.
  const kept = (ch) => ch.paired && !!ch.claims.site && !!ch.walletBinding && !(ch.legacyWallet && !legacy());
  const snapshot = () => {
    const list = [...channels].filter(([, ch]) => kept(ch));
    list.sort((a, b) => b[1].lastActive - a[1].lastActive);
    const out = {};
    for (const [id, ch] of list.slice(0, LIMITS.stateChannels)) {
      out[id] = {
        o: ch.origin,
        sc: ch.claims.site,
        wl: ch.claims.wallet,
        wb: ch.walletBinding,
        sb: ch.siteBinds,
        ...(ch.legacyWallet && { lw: true }),
        at: ch.lastActive,
      };
      ch.savedAt = ch.lastActive;
    }
    return JSON.stringify({ v: 1, channels: out });
  };
  // A fresh, unguessable temporary name opened exclusively (never follows a planted link), synced, then renamed.
  const tmpPath = () => `${stateFile}.${randomBytes(8).toString('hex')}.tmp`;
  const writeNow = (json) => {
    const tmp = tmpPath();
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeSync(fd, json);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, stateFile);
    } catch (e) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        /* never made */
      }
      log({ stateWrite: 'failed', code: e?.code });
    }
  };
  const writeLater = async (json) => {
    const tmp = tmpPath();
    let fh;
    try {
      fh = await openFile(tmp, 'wx', 0o600);
      await fh.writeFile(json);
      await fh.sync();
      await fh.close();
      fh = null;
      await rename(tmp, stateFile);
    } catch (e) {
      await fh?.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      log({ stateWrite: 'failed', code: e?.code });
    }
  };
  let saveTimer = null;
  let writing = false;
  let again = false;
  let finalJson = null; // what close() wrote, put back if an earlier write lands after it
  /** Write once after changes settle (debounced, asynchronous, one write at a time). */
  const save = () => {
    if (!stateFile || closed || saveTimer) return;
    saveTimer = setTimeout(runSave, stateWriteMs);
    saveTimer.unref?.();
  };
  const runSave = async () => {
    saveTimer = null;
    if (closed) return;
    if (writing) {
      again = true;
      return;
    }
    writing = true;
    await writeLater(snapshot());
    writing = false;
    if (closed) {
      if (finalJson !== null) writeNow(finalJson);
    } else if (again) {
      again = false;
      save();
    }
  };
  /** A missing, unreadable or corrupt file starts empty; bad or lapsed entries are skipped one by one. */
  const restore = () => {
    if (!stateFile) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') log({ stateRead: 'ignored', code: e?.code ?? 'parse' });
      return;
    }
    const list = raw?.v === 1 && raw.channels && typeof raw.channels === 'object' ? raw.channels : {};
    const digest = (x) => (x === null ? null : typeof x === 'string' && CLAIM_DIGEST.test(x) ? x : undefined);
    const t = now();
    const ok = [];
    for (const [id, s] of Object.entries(list)) {
      if (!CHANNEL.test(id) || !s || typeof s !== 'object' || !acceptableOrigin(s.o)) continue;
      if (!Number.isFinite(s.at) || s.at > t || t - s.at > LIMITS.pairedIdleMs) continue;
      const wl = digest(s.wl);
      if (!digest(s.sc) || !digest(s.wb) || wl === undefined) continue;
      ok.push([id, s, wl]);
    }
    ok.sort((a, b) => b[1].at - a[1].at);
    for (const [id, s, wl] of ok.slice(0, LIMITS.stateChannels))
      channels.set(
        id,
        newChannel({
          origin: s.o,
          expiry: 0,
          ip: null,
          paired: true,
          lastActive: s.at,
          claims: { site: s.sc, wallet: wl },
          walletBinding: s.wb,
          siteBinds: s.sb === true,
          legacyWallet: s.lw === true,
        }),
      );
  };
  restore();

  const drop = (id) => {
    const ch = channels.get(id);
    if (!ch) return;
    for (const role of ROLES) ch[role]?.close(4000, 'channel closed');
    channels.delete(id);
    if (ch.ip !== null) perIp.set(ch.ip, Math.max(0, (perIp.get(ch.ip) ?? 1) - 1));
    if (kept(ch)) save();
  };

  // Activity is saved at most hourly; the paired idle window is a month.
  const STATE_ACTIVITY_MS = 60 * 60_000;
  const sweep = () => {
    const t = now();
    for (const [id, ch] of channels) {
      const idle = t - ch.lastActive;
      const bothGone = !ch.site && !ch.wallet;
      // A wallet that got its role first-come (window only) counts as unpaired once the window has closed.
      const unpaired = !ch.paired || (ch.legacyWallet && !legacy());
      if (idle > LIMITS.pairedIdleMs || (unpaired && bothGone && idle > LIMITS.unpairedIdleMs)) drop(id);
      for (const role of ROLES) ch.queue[role] = ch.queue[role].filter((q) => t - q.at < LIMITS.queueMs);
      if (kept(ch) && ch.lastActive - ch.savedAt > STATE_ACTIVITY_MS) save();
    }
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref?.();

  /** True when this claim is the QR-bound wallet claim the site registered (`wc`). */
  const qrBound = (ch, role, claim) =>
    role === 'wallet' && !!ch.walletBinding && !!claim && claimHash(claim) === ch.walletBinding;

  /**
   * Who may take a role:
   * - the QR-bound wallet claim always may (it evicts anyone who got there first: N3-2);
   * - a claimed role admits only its claim;
   * - an unclaimed role: during the compatibility window, anyone. After it, an unclaimed site role takes any claim,
   *   and an unclaimed wallet role takes only the bound claim (above): never the first wallet that comes, even on a
   *   channel opened during the window without `wc` (b-Aware triage 13 Nov 2026).
   */
  const claimOk = (ch, role, claim) => {
    if (qrBound(ch, role, claim)) return true;
    const held = ch.claims?.[role];
    if (held) return claim !== null && claimHash(claim) === held;
    if (legacy()) return true;
    if (role === 'wallet') return false;
    return claim !== null;
  };

  /**
   * May this wallet join bind the role to its session claim digest `nc`? Only the phone that proves it saw the QR (the
   * bound claim) while that QR is still live, or the first wallet on a channel nobody bound (sites and CLIs without
   * `wc`; inside the compatibility window only, as claimOk refuses that wallet afterwards). Never a claim the relay
   * admitted only because of the window on a channel that has a binding: that would let a squatter pin the role before
   * the phone. Never a v1 session's claim later on (review 13 Nov 2026): whoever saw the QR holds the
   * same claim and could bind their own `nc`, locking the phone out for good. A v1 session upgrades through its site
   * instead (the site proves its claim and re-binds with `wc`; see attach).
   */
  const mayBind = (ch, role, claim, nc) =>
    role === 'wallet' &&
    !!nc &&
    ((qrBound(ch, role, claim) && now() <= ch.expiry) || (!ch.walletBinding && !ch.claims.wallet));

  /** Decide whether an upgrade is allowed. Returns { ok, code, reason, ... }. */
  function admit(req) {
    const url = new URL(req.url, 'http://relay');
    const m = url.pathname.match(/^\/v1\/c\/([^/]+)$/);
    const role = url.searchParams.get('role');
    if (!m || !CHANNEL.test(m[1]) || !ROLES.has(role)) return { ok: false, code: 400, reason: 'bad request' };
    const claim = url.searchParams.get('claim');
    if (claim !== null && !CLAIM.test(claim)) return { ok: false, code: 400, reason: 'bad request' };
    const wc = url.searchParams.get('wc');
    if (wc !== null && (role !== 'site' || !CLAIM_DIGEST.test(wc)))
      return { ok: false, code: 400, reason: 'bad request' };
    const nc = url.searchParams.get('nc');
    if (nc !== null && (role !== 'wallet' || !CLAIM_DIGEST.test(nc)))
      return { ok: false, code: 400, reason: 'bad request' };
    const id = m[1];
    const ip = clientIp(req, trustedProxies);
    let ch = channels.get(id);
    const t = now();

    if (role === 'site') {
      const origin = req.headers.origin;
      if (!acceptableOrigin(origin)) return { ok: false, code: 403, reason: 'origin' };
      if (ch) {
        if (ch.origin !== origin) return { ok: false, code: 403, reason: 'origin mismatch' };
        if (!claimOk(ch, role, claim)) return { ok: false, code: 403, reason: 'role claimed' };
        return { ok: true, id, role, ch, claim, wc };
      }
      const e = Number(url.searchParams.get('e'));
      if (!Number.isFinite(e) || e * 1000 < t || e * 1000 > t + LIMITS.maxQrLifetimeS * 1000)
        return { ok: false, code: 400, reason: 'expiry' };
      // A new channel needs a site claim, so nobody else can take the site socket later (N3-1), and `wc`, so the wallet
      // role goes only to the phone that scanned the QR, never to whoever joins first (b-Aware triage 13 Nov 2026).
      if (claim === null && !legacy()) return { ok: false, code: 403, reason: 'claim required' };
      if (wc === null && !legacy()) return { ok: false, code: 403, reason: 'wallet binding required' };
      if ((perIp.get(ip) ?? 0) >= LIMITS.channelsPerIp) return { ok: false, code: 429, reason: 'too many channels' };
      ch = newChannel({
        origin,
        expiry: e * 1000,
        ip,
        paired: false,
        lastActive: t,
        claims: { site: null, wallet: null },
        walletBinding: wc,
        siteBinds: claim !== null,
      });
      channels.set(id, ch);
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      return { ok: true, id, role, ch, claim };
    }

    // wallet
    if (!ch) return { ok: false, code: 404, reason: 'no such channel' };
    // Unpaired: the QR must still be fresh. The site socket may be away (iOS suspends Safari while the
    // user switches to bWallet on the same phone); the channel and its origin were fixed when the site
    // opened it, so the wallet may join and its frames queue for the site like any other away case.
    if (!ch.paired && t > ch.expiry) return { ok: false, code: 410, reason: 'qr expired' };
    if (!claimOk(ch, role, claim)) return { ok: false, code: 403, reason: 'role claimed' };
    // After the cut-over a wallet taking an empty role must be a v2 wallet (the owner reconnecting holds the role).
    if (sessionClaimsRequired() && !ch.claims.wallet && !nc)
      return { ok: false, code: 403, reason: 'claim proof required' };
    return { ok: true, id, role, ch, claim, nc };
  }

  function attach(ws, { role, ch, claim, wc = null, nc = null }) {
    // Re-check: another socket may have claimed the role between admit and the upgrade finishing.
    if (!claimOk(ch, role, claim ?? null)) return ws.close(4003, 'role claimed');
    // Only a site claim the relay already held may move the wallet binding, never one this attach is pinning now, and
    // only the one that opened the channel (a claim pinned later on a channel opened without one never may).
    const siteProven =
      role === 'site' && ch.siteBinds && !!claim && !!ch.claims.site && ch.claims.site === claimHash(claim);
    // Nobody bound or holds the wallet role and this wallet takes it: first come, which only the window lets through.
    if (role === 'wallet' && !ch.walletBinding && !ch.claims.wallet) ch.legacyWallet = true;
    let bound = false;
    // Review 22 Nov 2026: who held the wallet role before this attach. If that changes, frames the old holder queued
    // for the site are dropped, so a returning site never reads a replaced wallet's hello or ready.
    const heldBefore = ch.claims.wallet;
    if (mayBind(ch, role, claim, nc)) {
      // Wallet claim v2: from now on only the session claim admits the wallet; the QR claim is spent.
      ch.walletBinding = nc;
      ch.claims.wallet = nc;
      bound = true;
    } else if (qrBound(ch, role, claim)) ch.claims[role] = ch.walletBinding;
    else if (claim && !ch.claims[role]) ch.claims[role] = claimHash(claim);
    // A site that proved its own claim may re-bind the wallet role to the session claim digest it knows (v2 pairing).
    if (siteProven && wc && ch.walletBinding !== wc) {
      ch.walletBinding = wc;
      ch.claims.wallet = wc;
    }
    // The wallet role is now bound to a digest the site chose (only the paired ends can compute it), not first-come.
    if (siteProven && wc) ch.legacyWallet = false;
    if (role === 'wallet' && ch.claims.wallet !== heldBefore) ch.queue.site = [];
    ch[role]?.close(4001, 'replaced');
    ch[role] = ws;
    ch.lastActive = now();
    if (role === 'wallet') {
      ch.paired = true;
      // `wcv` tells the wallet its session claim is the one bound here: just bound, or bound earlier (by this wallet
      // or by the site re-binding it) and brought again. An older relay never says so.
      const holds = !!nc && ch.walletBinding === nc && !!claim && claimHash(claim) === nc;
      send(ws, { t: 'relay', verifiedOrigin: ch.origin, ...((bound || holds) && { wcv: WALLET_CLAIM_V2 }) });
    }
    send(ch[other(role)], { t: 'relay', peer: 'joined', role });
    // Deliver what arrived while this side was away.
    const t = now();
    for (const q of ch.queue[role].splice(0)) if (t - q.at < LIMITS.queueMs) ws.send(q.data);
    if (kept(ch)) save();

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4002, 'text frames only');
      const t2 = now();
      if (t2 - ch.rate.start > 60_000) ch.rate = { start: t2, n: 0 };
      if (++ch.rate.n > LIMITS.framesPerMinute) return send(ws, { t: 'relay', error: 'rate limited' });
      ch.lastActive = t2;
      const text = data.toString();
      const peer = ch[other(role)];
      if (peer && peer.readyState === 1) peer.send(text);
      else {
        const q = ch.queue[other(role)];
        q.push({ at: t2, data: text });
        if (q.length > LIMITS.queueFrames) q.shift();
      }
    });
    ws.on('close', () => {
      if (ch[role] !== ws) return;
      ch[role] = null;
      send(ch[other(role)], { t: 'relay', peer: 'left', role });
    });
  }

  server?.on('upgrade', (req, socket, head) => {
    // After close() the socket server refuses upgrades; answer it ourselves rather than hand ws a
    // late connection (Bun's ws shim crashes in abortHandshake on that path).
    if (closed) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const a = admit(req);
    if (!a.ok) {
      socket.write(`HTTP/1.1 ${a.code} ${a.reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, a));
  });

  return {
    stats: () => ({ channels: channels.size, sockets: wss.clients.size }),
    /** Write the state file now, synchronously (shutdown). */
    flush: () => {
      if (stateFile && !closed) writeNow(snapshot());
    },
    close: () => {
      // Kept on disk as it is: closing the sockets below must not empty the file.
      if (stateFile && !closed) writeNow((finalJson = snapshot()));
      if (saveTimer) clearTimeout(saveTimer);
      closed = true;
      clearInterval(timer);
      for (const id of [...channels.keys()]) drop(id);
      wss.close();
    },
    _sweep: sweep,
  };
}
