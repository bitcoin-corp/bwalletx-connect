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
  /**
   * bWalletX 5.2.61+: sign the link's sign-in (ln/lx) with Connect. The signature goes ONLY in the return fragment's
   * sealed ready; over the relay the ready says `ls: 1` ("signed in, see the return") and carries no signature.
   */
  fold?: boolean;
  /** An old/hostile wallet that puts the signature in the RELAY ready (sites must ignore it). */
  loginOverRelay?: boolean;
  /** Don't Connect on join; call phone.connect() later (the user is reading the card). */
  manual?: boolean;
  /** createAction is recorded but never answered (the payment sheet is still up). */
  slowActions?: boolean;
  /** These actions are recorded but never answered (their sheet is still up). */
  slow?: string[];
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

  const folded = () => !!((opts.fold || opts.loginOverRelay) && l.ln && l.lx);
  /** The relay's ready. */
  const relayReady = async (): Promise<PairMessage> =>
    opts.loginOverRelay ? loginReady() : folded() ? ({ t: 'ready', ls: 1 } as PairMessage) : { t: 'ready' };
  /** The ready with the signature, for the return fragment only. */
  const loginReady = async (): Promise<PairMessage> => {
    if (!folded()) return { t: 'ready' };
    const message = loginMessageFor(l.o, l.ln!, l.lx!);
    const { signature } = (await pw.createSignature({
      protocolID: [2, 'bwallet sign in'],
      keyID: l.ln,
      counterparty: 'anyone',
      data: Array.from(new TextEncoder().encode(message)),
    })) as { signature: number[] };
    return { t: 'ready', login: { k: root.toPublicKey().toString(), sig: Utils.toHex(signature) } };
  };
  /** Seal the relay ready, then (folded) the fragment's ready with the signature, which gets the HIGHER seq. */
  const readyFrames = async () => {
    const relayFrame = await state.sealer!.seal(await relayReady());
    const returnFrame = opts.fold && folded() ? await state.sealer!.seal(await loginReady()) : relayFrame;
    return { relayFrame, returnFrame };
  };

  state.connect = async () => {
    const ws = state.ws!;
    const { relayFrame, returnFrame } = await readyFrames();
    state.readyFrame = relayFrame;
    if (ws.readyState === 1) ws.send(JSON.stringify(relayFrame));
    if (l.ret && l.rid) state.returnTo = `${l.ret}#${returnFragment(l.rid, P.toPublicKey().toString(), returnFrame)}`;
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
          const { relayFrame, returnFrame } = await readyFrames();
          state.readyFrame = relayFrame;
          ws.send(state.hello);
          ws.send(JSON.stringify(relayFrame));
          if (l.ret && l.rid) state.returnTo = `${l.ret}#${returnFragment(l.rid, P.toPublicKey().toString(), returnFrame)}`;
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
        if (state.readyFrame) ws.send(JSON.stringify(await state.sealer.seal(await relayReady())));
        return;
      }
      if (!state.sealer || !isSealed(f)) return;
      const m = (await state.sealer.open(f)) as PairMessage | null;
      if (m?.t !== 'req') return;
      // A repeated id gets the stored answer, sealed afresh (bWalletX ReplyBook: never run twice).
      const seen = answers.get(m.id);
      if (seen) return ws.send(JSON.stringify(await state.sealer.seal(seen)));
      state.requests.push(m.action);
      if (opts.slowActions && m.action === 'createAction') return;
      if (opts.slow?.includes(m.action)) return;
      // ProtoWallet has no createAction: answer a spend with a stand-in txid.
      const result = m.action === 'createAction' ? { txid: '00'.repeat(32) } : await pw[m.action].call(pw, m.params);
      const res: PairMessage = { t: 'res', id: m.id, result };
      answers.set(m.id, res);
      ws.send(JSON.stringify(await state.sealer.seal(res)));
    };
  };
  state.ws = socket(relaySocketUrl(l.r, l.c, 'wallet'));
  serve(state.ws);
  return state;
}
