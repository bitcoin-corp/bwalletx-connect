import type { SocketLike } from '../src/pair';

/**
 * An in-memory stand-in for relay.bwallet.space: two roles per channel, frames passed through. Like the real relay
 * (relay/relay.mjs in bwalletX), frames for a side that is away are queued and delivered when it rejoins, and the
 * other side hears { t: 'relay', peer: 'joined' | 'left', role }.
 */
export class FakeRelay {
  channels = new Map<string, { site?: FakeSocket; wallet?: FakeSocket; queue: { site: string[]; wallet: string[] } }>();
  urls: string[] = [];
  constructor(public origin = 'https://example.com') {}

  socket = (url: string): SocketLike => {
    this.urls.push(url);
    const u = new URL(url);
    const channel = u.pathname.split('/').pop()!;
    const role = u.searchParams.get('role') as 'site' | 'wallet';
    const s = new FakeSocket(this, channel, role);
    const ch = this.channels.get(channel) ?? { queue: { site: [], wallet: [] } };
    const old = ch[role];
    ch[role] = s;
    old?.close();
    this.channels.set(channel, ch);
    queueMicrotask(() => {
      if (s.readyState !== 0) return;
      s.readyState = 1;
      s.onopen?.({});
      if (role === 'wallet') s.deliver(JSON.stringify({ t: 'relay', verifiedOrigin: this.origin }));
      const other = role === 'site' ? ch.wallet : ch.site;
      if (other && other.readyState === 1) other.deliver(JSON.stringify({ t: 'relay', peer: 'joined', role }));
      for (const q of ch.queue[role].splice(0)) s.deliver(q);
    });
    return s;
  };

  peer(s: FakeSocket) {
    const ch = this.channels.get(s.channel);
    return s.role === 'site' ? ch?.wallet : ch?.site;
  }

  /** Queue `data` for the other side of `s` (it is away). */
  hold(s: FakeSocket, data: string) {
    this.channels.get(s.channel)?.queue[s.role === 'site' ? 'wallet' : 'site'].push(data);
  }

  /** What iOS does to a tab or app the user left: its socket dies without a word to the page. */
  kill(channel: string, role: 'site' | 'wallet') {
    const s = this.channels.get(channel)?.[role];
    if (s) s.drop();
  }
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  /** Frozen: the page is asleep. Frames sent to it are lost (the relay thinks the socket is open). */
  frozen = false;
  constructor(private relay: FakeRelay, public channel: string, public role: 'site' | 'wallet') {}
  deliver(data: string) {
    if (this.frozen) return;
    this.onmessage?.({ data });
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('not open');
    const p = this.relay.peer(this);
    // Delivered synchronously, back to back, as a fast network can.
    if (p && p.readyState === 1) p.deliver(data);
    else this.relay.hold(this, data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
  /** Closed with no close event yet (the page is suspended); the event fires when it wakes. */
  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const ch = this.relay.channels.get(this.channel);
    const p = this.relay.peer(this);
    if (ch && ch[this.role] === this) ch[this.role] = undefined;
    if (p && p.readyState === 1) p.deliver(JSON.stringify({ t: 'relay', peer: 'left', role: this.role }));
  }
  /** The suspended page wakes and finally hears that its socket is gone. */
  wakeClosed() {
    this.onclose?.({});
  }
}
