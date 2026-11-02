import type { SocketLike } from '../src/pair';

/**
 * An in-memory stand-in for relay.bwallet.space: two roles per channel, frames passed through. With `queue`, frames
 * for a side that is away wait and are delivered when it joins again (as the real relay does, relay/relay.mjs).
 */
export class FakeRelay {
  channels = new Map<string, { site?: FakeSocket; wallet?: FakeSocket }>();
  queued = new Map<string, string[]>();
  urls: string[] = [];
  constructor(public origin = 'https://example.com', public opts: { queue?: boolean } = {}) {}

  socket = (url: string): SocketLike => {
    this.urls.push(url);
    const u = new URL(url);
    const channel = u.pathname.split('/').pop()!;
    const role = u.searchParams.get('role') as 'site' | 'wallet';
    const s = new FakeSocket(this, channel, role);
    const ch = this.channels.get(channel) ?? {};
    ch[role]?.close();
    ch[role] = s;
    this.channels.set(channel, ch);
    queueMicrotask(() => {
      s.readyState = 1;
      s.onopen?.({});
      if (role === 'wallet') s.deliver(JSON.stringify({ t: 'relay', verifiedOrigin: this.origin }));
      const k = `${channel}|${role}`;
      for (const f of this.queued.get(k)?.splice(0) ?? []) s.deliver(f);
    });
    return s;
  };

  peer(s: FakeSocket) {
    const ch = this.channels.get(s.channel);
    return s.role === 'site' ? ch?.wallet : ch?.site;
  }
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(public relay: FakeRelay, public channel: string, public role: 'site' | 'wallet') {}
  deliver(data: string) {
    this.onmessage?.({ data });
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('not open');
    const p = this.relay.peer(this);
    // Delivered synchronously, back to back, as a fast network can.
    if (p && p.readyState === 1) p.deliver(data);
    else if (this.relay.opts.queue) {
      const k = `${this.channel}|${this.role === 'site' ? 'wallet' : 'site'}`;
      this.relay.queued.set(k, [...(this.relay.queued.get(k) ?? []), data]);
    }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}
