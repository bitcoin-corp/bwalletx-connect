import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import {
  Sealer,
  deriveSession,
  isSealed,
  loginMessageFor,
  parsePairUrl,
  relaySocketUrl,
  returnFragment,
  type PairMessage,
  type SealedFrame,
} from '../src/protocol';
import type { SocketFactory, SocketLike } from '../src/pair';

export interface FakePhoneOptions {
  /** Derive the session first, then send hello and the sealed ready in the same tick (worst case for the site). */
  burst?: boolean;
  /** bWalletX 5.2.61+: sign the link's sign-in (ln/lx) with Connect and put it in ready. */
  fold?: boolean;
  /** Don't Connect on join; call phone.connect() later (the user is reading the card). */
  manual?: boolean;
}

/**
 * A simulated bWalletX phone: what src/mobile/pair/sessions.ts does on scan and Connect. Like the real wallet it
 * says hello and ready again when the site rejoins, and answers a repeated request id with the stored answer.
 */
export function fakePhone(link: string, socket: SocketFactory, root: PrivateKey, opts: FakePhoneOptions = {}) {
  const l = parsePairUrl(link);
  const P = PrivateKey.fromRandom();
  const pw = new ProtoWallet(root) as unknown as Record<string, (a: unknown) => Promise<unknown>>;
  const answers = new Map<string, PairMessage>();
  const state: {
    code?: string;
    ws?: SocketLike;
    sealer?: Sealer;
    requests: string[];
    readyFrame?: SealedFrame;
    /** Where the wallet would send the user back (ret + fragment), once Connected with a ret/rid link. */
    returnTo?: string;
    connect: () => Promise<void>;
    hello: string;
  } = { requests: [], hello: '', connect: async () => {} };
  state.hello = JSON.stringify({ t: 'hello', k: P.toPublicKey().toString(), info: { name: 'test', rdns: 'space.bwallet.mobile' } });

  const readyMsg = async (): Promise<PairMessage> => {
    if (!opts.fold || !l.ln || !l.lx) return { t: 'ready' };
    const message = loginMessageFor(l.o, l.ln, l.lx);
    const { signature } = (await pw.createSignature({
      protocolID: [2, 'bwallet sign in'],
      keyID: l.ln,
      counterparty: 'anyone',
      data: Array.from(new TextEncoder().encode(message)),
    })) as { signature: number[] };
    return { t: 'ready', login: { k: root.toPublicKey().toString(), sig: Utils.toHex(signature) } };
  };

  state.connect = async () => {
    const ws = state.ws!;
    const frame = await state.sealer!.seal(await readyMsg());
    state.readyFrame = frame;
    if (ws.readyState === 1) ws.send(JSON.stringify(frame));
    if (l.ret && l.rid) state.returnTo = `${l.ret}#${returnFragment(l.rid, P.toPublicKey().toString(), frame)}`;
  };

  const serve = (ws: SocketLike) => {
    ws.onmessage = async (ev) => {
      const f = JSON.parse(String(ev.data));
      if (f.t === 'relay' && f.verifiedOrigin && !state.sealer) {
        if (f.verifiedOrigin !== l.o) throw new Error('origin mismatch');
        if (opts.burst) {
          const s = await deriveSession(P, l.k, l.c);
          state.code = s.code;
          state.sealer = new Sealer(s.key, 'wallet');
          // Seal ready BEFORE saying hello, then send both in the same tick.
          const frame = await state.sealer.seal(await readyMsg());
          state.readyFrame = frame;
          ws.send(state.hello);
          ws.send(JSON.stringify(frame));
          if (l.ret && l.rid) state.returnTo = `${l.ret}#${returnFragment(l.rid, P.toPublicKey().toString(), frame)}`;
        } else {
          ws.send(state.hello);
          const s = await deriveSession(P, l.k, l.c);
          state.code = s.code;
          state.sealer = new Sealer(s.key, 'wallet');
          if (!opts.manual) await state.connect();
        }
        return;
      }
      // The site's tab came back: hello again (its key may have been lost with a frozen socket), and ready if Connected.
      if (f.t === 'relay' && f.peer === 'joined' && f.role === 'site' && state.sealer) {
        ws.send(state.hello);
        if (state.readyFrame) ws.send(JSON.stringify(await state.sealer.seal(await readyMsg())));
        return;
      }
      if (!state.sealer || !isSealed(f)) return;
      const m = (await state.sealer.open(f)) as PairMessage | null;
      if (m?.t !== 'req') return;
      // A repeated id gets the stored answer, sealed afresh (bWalletX ReplyBook: never run twice).
      const seen = answers.get(m.id);
      if (seen) return ws.send(JSON.stringify(await state.sealer.seal(seen)));
      state.requests.push(m.action);
      const result = await pw[m.action].call(pw, m.params);
      const res: PairMessage = { t: 'res', id: m.id, result };
      answers.set(m.id, res);
      ws.send(JSON.stringify(await state.sealer.seal(res)));
    };
  };
  state.ws = socket(relaySocketUrl(l.r, l.c, 'wallet'));
  serve(state.ws);
  return state;
}
