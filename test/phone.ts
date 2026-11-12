import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { Sealer, claimDigest, deriveSession, isSealed, parsePairUrl, relaySocketUrl, sessionWalletClaim, walletClaimFor, type PairMessage } from '../src/protocol';
import type { SocketFactory, SocketLike } from '../src/pair';

/**
 * A simulated bWalletX phone: what src/mobile/pair/sessions.ts does on scan and Connect.
 * `burst`: derive the session first, then send hello and the sealed ready in the same tick
 * (the worst case for the site's frame handling).
 */
export function fakePhone(link: string, socket: SocketFactory, root: PrivateKey, opts: { burst?: boolean; v2?: boolean } = {}) {
  const l = parsePairUrl(link);
  const P = PrivateKey.fromRandom();
  const pw = new ProtoWallet(root) as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  const state: { code?: string; ws?: SocketLike; sealer?: Sealer; requests: string[]; sessionClaim?: string } = { requests: [] };

  const serve = (ws: SocketLike) => {
    ws.onmessage = async (ev) => {
      const f = JSON.parse(String(ev.data));
      if (f.t === 'relay' && f.verifiedOrigin && !state.sealer) {
        if (f.verifiedOrigin !== l.o) throw new Error('origin mismatch');
        const hello = JSON.stringify({
          t: 'hello',
          k: P.toPublicKey().toString(),
          info: { name: 'test', rdns: 'space.bwallet.mobile' },
          ...(f.wcv === 2 && { wcv: 2 }),
        });
        if (opts.burst) {
          const s = await deriveSession(P, l.k, l.c);
          state.code = s.code;
          state.sealer = new Sealer(s.key, 'wallet');
          const ready = JSON.stringify(await state.sealer.seal({ t: 'ready' }));
          ws.send(hello);
          ws.send(ready);
        } else {
          ws.send(hello);
          const s = await deriveSession(P, l.k, l.c);
          state.code = s.code;
          state.sealer = new Sealer(s.key, 'wallet');
          ws.send(JSON.stringify(await state.sealer.seal({ t: 'ready' })));
        }
        return;
      }
      if (!state.sealer || !isSealed(f)) return;
      const m = (await state.sealer.open(f)) as PairMessage | null;
      if (m?.t !== 'req') return;
      state.requests.push(m.action);
      const result = await pw[m.action].call(pw, m.params);
      ws.send(JSON.stringify(await state.sealer.seal({ t: 'res', id: m.id, result })));
    };
  };
  if (opts.v2) {
    // Wallet claim v2, as bWalletX does: the QR claim for this first join, plus the session claim's digest as nc.
    state.sessionClaim = sessionWalletClaim(P, l.k, l.c);
    void Promise.all([walletClaimFor(l.c, l.k), claimDigest(state.sessionClaim)]).then(([qr, nc]) => {
      state.ws = socket(relaySocketUrl(l.r, l.c, 'wallet', undefined, qr, nc));
      serve(state.ws);
    });
    return state;
  }
  state.ws = socket(relaySocketUrl(l.r, l.c, 'wallet'));
  serve(state.ws);
  return state;
}
