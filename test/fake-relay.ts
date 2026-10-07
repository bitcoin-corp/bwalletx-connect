import type { SocketLike } from '../src/pair';

/** An in-memory stand-in for relay.bwallet.space: two roles per channel, frames passed through. */
export class FakeRelay {
  channels = new Map<string, { site?: FakeSocket; wallet?: FakeSocket }>();
  constructor(public origin = 'https://example.com') {}

  socket = (url: string): SocketLike => {
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
  constructor(private relay: FakeRelay, public channel: string, public role: 'site' | 'wallet') {}
  deliver(data: string) {
    this.onmessage?.({ data });
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('not open');
    const p = this.relay.peer(this);
    // Delivered synchronously, back to back, as a fast network can.
    if (p && p.readyState === 1) p.deliver(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}
