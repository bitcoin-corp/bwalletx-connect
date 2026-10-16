import { Hash, PrivateKey, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import { AccessError, canonicalJson, parseAccessChallenge, PROTOCOL_MEDIA, tokenNeedRaw, type AccessResponse } from '../src/access';
import { proveHoldings, requestAccess, toAccessError } from '../src/access-client';
import { createAccessChallenge, verifyAccess, type AccessResolver } from '../src/access-server';
import { createBwalletXAccess } from '../src/next';
import { memoryStore } from '../src/server';

const ORIGIN = 'https://b0ase.com';
const TOKEN = `bsv21:${'ab'.repeat(32)}_0`;
const SECRET = 'x'.repeat(40);

/** A BRC-100-ish wallet: ProtoWallet + a token basket with outputs at derived keys. */
function fakeWallet(root: PrivateKey, keyIDs: string[], amt = '100', token = TOKEN): WalletInterface {
  const pw = new ProtoWallet(root);
  return {
    getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => pw.getPublicKey(a),
    createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => pw.createSignature(a),
    async listOutputs() {
      const outputs = [];
      for (const [i, keyID] of keyIDs.entries()) {
        const { publicKey } = await pw.getPublicKey({ protocolID: [0, 'onesat'], keyID, counterparty: 'self' });
        const h = Utils.toHex(Hash.hash160(Utils.toArray(publicKey, 'hex')));
        outputs.push({
          outpoint: `${'cd'.repeat(32)}.${i}`,
          satoshis: 1,
          spendable: true,
          lockingScript: `0063036f7264${'00'.repeat(4)}6876a914${h}88ac`,
          customInstructions: JSON.stringify({ id: token.replace('bsv21:', ''), amt, keyID }),
        });
      }
      return { totalOutputs: outputs.length, outputs };
    },
  } as unknown as WalletInterface;
}

/** Resolver backed by a map of address → balance. */
function resolver(bal: Record<string, string>, opts: { level?: number; kyc?: boolean; down?: boolean; supply?: string } = {}): AccessResolver & { bal: Record<string, string> } {
  return {
    bal,
    async tokenBalance(_id, addresses) {
      if (opts.down) throw new Error('indexer down');
      return addresses.reduce((s, a) => s + BigInt(bal[a] ?? '0'), 0n).toString();
    },
    async tokenSupply() {
      if (!opts.supply) throw new Error('no supply');
      return opts.supply;
    },
    async identity() {
      if (opts.down) throw new Error('down');
      return { level: opts.level ?? 0, kyc: !!opts.kyc };
    },
  };
}

async function addressesOf(w: WalletInterface, keyIDs: string[]) {
  const out: string[] = [];
  for (const keyID of keyIDs) {
    const { publicKey } = await w.getPublicKey({ protocolID: [0, 'onesat'], keyID, counterparty: 'self' });
    const { PublicKey } = await import('@bsv/sdk');
    out.push(PublicKey.fromString(publicKey).toAddress());
  }
  return out;
}

async function flow(opts: {
  require?: Parameters<typeof createAccessChallenge>[0]['require'];
  res?: AccessResolver;
  wallet?: WalletInterface;
  sub?: string;
  tamper?: (r: AccessResponse) => AccessResponse;
  now?: number;
}) {
  const store = memoryStore({ quiet: true });
  const root = PrivateKey.fromRandom();
  const wallet = opts.wallet ?? fakeWallet(root, ['k1', 'k2']);
  const require = opts.require ?? { token: { id: TOKEN, min: '150' } };
  const res = opts.res ?? resolver(Object.fromEntries((await addressesOf(wallet, ['k1', 'k2'])).map((a) => [a, '100'])));
  const { response } = await requestAccess({
    wallet,
    challenge: async (identityKey) => createAccessChallenge({ origin: ORIGIN, require, store, identityKey: opts.sub ?? identityKey }),
  });
  const body = opts.tamper ? opts.tamper(response) : response;
  return { store, body, verify: () => verifyAccess({ origin: ORIGIN, response: body, store, resolver: res, require, now: opts.now }) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof AccessError ? e.code : `other:${(e as Error).message}`;
  }
};

describe('access protocol', () => {
  it('canonical JSON sorts keys and round-trips through parse', async () => {
    expect(canonicalJson({ b: 1, a: [true, null, 's'], c: undefined })).toBe('{"a":[true,null,"s"],"b":1}');
    const c = await createAccessChallenge({ origin: ORIGIN, require: { token: { id: TOKEN, min: '1' } }, store: memoryStore({ quiet: true }) });
    expect(parseAccessChallenge(c.challenge).kind).toBe('403');
    expect(() => parseAccessChallenge(c.challenge.replace('{"exp"', '{ "exp"'))).toThrow(AccessError);
  });

  it('exports media for each kind', () => {
    expect(PROTOCOL_MEDIA['401'].color).toBe('#22c55e');
    expect(PROTOCOL_MEDIA['403'].video).toBe('assets/protocol/403.mp4');
  });

  it('grants when proven keys hold enough (sum over keys)', async () => {
    const f = await flow({});
    const g = await f.verify();
    expect(g.have.tokenRaw).toBe('200');
    expect(g.addresses).toHaveLength(2);
  });

  it('insufficient_tokens with have/need', async () => {
    const f = await flow({ require: { token: { id: TOKEN, min: '201' } } });
    await expect(f.verify()).rejects.toMatchObject({ code: 'insufficient_tokens', have: '200', need: '201' });
  });

  it('minBps uses supply, rounding up; supply missing is indexer_unavailable', async () => {
    expect(tokenNeedRaw({ id: TOKEN, minBps: 1 }, '1000000000')).toBe('100000');
    expect(tokenNeedRaw({ id: TOKEN, minBps: 1 }, '5')).toBe('1');
    const root = PrivateKey.fromRandom();
    const w = fakeWallet(root, ['k1', 'k2']);
    const bal = Object.fromEntries((await addressesOf(w, ['k1', 'k2'])).map((a) => [a, '100']));
    const ok = await flow({ wallet: w, require: { token: { id: TOKEN, minBps: 100 } }, res: resolver(bal, { supply: '20000' }) });
    expect((await ok.verify()).have.needRaw).toBe('200');
    const no = await flow({ wallet: w, require: { token: { id: TOKEN, minBps: 100 } }, res: resolver(bal) });
    expect(await code(no.verify())).toBe('indexer_unavailable');
  });

  it('indexer_unavailable when the balance read fails (never "holds 0")', async () => {
    const f = await flow({ res: resolver({}, { down: true }) });
    expect(await code(f.verify())).toBe('indexer_unavailable');
  });

  it('replay: the same response twice', async () => {
    const f = await flow({});
    await f.verify();
    expect(await code(f.verify())).toBe('replay');
  });

  it('expired', async () => {
    const f = await flow({ now: Date.now() + 10 * 60_000 });
    expect(await code(f.verify())).toBe('expired');
  });

  it('wrong_account when the wallet is a different identity than the challenge sub', async () => {
    const other = PrivateKey.fromRandom().toPublicKey().toString();
    expect(await code(flow({ sub: other }))).toBe('wrong_account');
    // and server-side, if a client skips the check
    const f = await flow({});
    const store = memoryStore({ quiet: true });
    const c = await createAccessChallenge({ origin: ORIGIN, require: { token: { id: TOKEN, min: '1' } }, store, identityKey: other });
    const forged = { ...f.body, challenge: c.challenge };
    expect(await code(verifyAccess({ origin: ORIGIN, response: forged, store, resolver: resolver({}) }))).toBe('wrong_account');
  });

  it('invalid_signature when the identity signature is bad', async () => {
    const f = await flow({ tamper: (r) => ({ ...r, signature: r.signature.map((b, i) => (i === 10 ? b ^ 1 : b)) }) });
    expect(await code(f.verify())).toBe('invalid_signature');
  });

  it('a holding proof by a key the user does not control counts nothing', async () => {
    const stranger = PrivateKey.fromRandom();
    const f = await flow({
      tamper: (r) => ({ ...r, holdings: [{ pubkey: stranger.toPublicKey().toString(), signature: r.holdings![0].signature }] }),
    });
    await expect(f.verify()).rejects.toMatchObject({ code: 'insufficient_tokens', have: '0' });
  });

  it('bad_request on malformed input and a tampered requirement', async () => {
    const store = memoryStore({ quiet: true });
    expect(await code(verifyAccess({ origin: ORIGIN, response: null, store, resolver: resolver({}) }))).toBe('bad_request');
    expect(await code(createAccessChallenge({ origin: ORIGIN, require: { token: { id: 'x' } } as never, store }))).toBe('bad_request');
    const f = await flow({});
    const c = JSON.parse(f.body.challenge);
    c.require.token.min = '1';
    expect(await code(verifyAccess({ origin: ORIGIN, response: { ...f.body, challenge: canonicalJson(c) }, store: f.store, resolver: resolver({}) }))).toBe('replay');
  });

  it('identity_level_too_low, kyc_required, and missing identity resolver', async () => {
    const lo = await flow({ require: { identityLevel: 3 }, res: resolver({}, { level: 2 }) });
    await expect(lo.verify()).rejects.toMatchObject({ code: 'identity_level_too_low', have: 2, need: 3 });
    const k = await flow({ require: { kyc: true }, res: resolver({}, { level: 4 }) });
    expect(await code(k.verify())).toBe('kyc_required');
    const ok = await flow({ require: { kyc: true, identityLevel: 4 }, res: resolver({}, { level: 4, kyc: true }) });
    expect((await ok.verify()).kind).toBe('401');
    const none = await flow({ require: { identityLevel: 1 }, res: { tokenBalance: async () => '0' } });
    expect(await code(none.verify())).toBe('indexer_unavailable');
  });

  it('client maps wallet failures: user_rejected, not_installed', async () => {
    const w = { getPublicKey: async () => { throw new Error('User rejected the request'); } } as unknown as WalletInterface;
    expect(await code(requestAccess({ wallet: w, challenge: async () => ({ challenge: '' }) }))).toBe('user_rejected');
    expect(toAccessError(Object.assign(new Error('x'), { code: 'NOT_FOUND' })).code).toBe('not_installed');
  });

  it('client surfaces server error bodies as AccessError', async () => {
    const store = memoryStore({ quiet: true });
    const w = fakeWallet(PrivateKey.fromRandom(), ['k1']);
    const p = requestAccess({
      wallet: w,
      challenge: async (identityKey) => createAccessChallenge({ origin: ORIGIN, require: { token: { id: TOKEN, min: '1' } }, store, identityKey }),
      verify: async () => ({ error: 'insufficient_tokens', message: 'no', have: '0', need: '1' }),
    });
    await expect(p).rejects.toMatchObject({ code: 'insufficient_tokens', need: '1' });
  });

  it('proveHoldings skips other tokens and dedupes keys', async () => {
    const w = fakeWallet(PrivateKey.fromRandom(), ['k1', 'k1', 'k2']);
    const proofs = await proveHoldings(w, '{"x":1}', TOKEN);
    expect(proofs).toHaveLength(2);
    expect(proofs[0].outpoints).toHaveLength(2);
    expect(await proveHoldings(w, '{"x":1}', `bsv21:${'ef'.repeat(32)}_0`)).toHaveLength(0);
  });
});

describe('createBwalletXAccess (Next adapter)', () => {
  const mk = async () => {
    const root = PrivateKey.fromRandom();
    const w = fakeWallet(root, ['k1']);
    const [addr] = await addressesOf(w, ['k1']);
    const res = resolver({ [addr]: '500' });
    const gate = createBwalletXAccess({ origin: ORIGIN, store: memoryStore({ quiet: true }), require: { token: { id: TOKEN, min: '100' } }, resolver: res, secret: SECRET, recheckEvery: 0 });
    const post = (url: string, b: unknown) => new Request(`${ORIGIN}${url}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { w, addr, res, gate, post };
  };

  it('grants, sets a cookie, and selling the tokens ends access on re-check', async () => {
    const { w, addr, res, gate, post } = await mk();
    const { response } = await requestAccess({
      wallet: w,
      challenge: async (identityKey) => (await gate.challenge(post('/c', { identityKey }))).json(),
    });
    const v = await gate.verify(post('/v', response));
    expect(v.status).toBe(200);
    const cookie = v.headers.get('set-cookie')!.split(';')[0];
    expect((await gate.getAccess(cookie)).ok).toBe(true);
    res.bal[addr] = '10';
    expect(await gate.getAccess(cookie)).toMatchObject({ ok: false, error: 'insufficient_tokens', need: '100' });
  });

  it('answers protocol codes with statuses', async () => {
    const { gate, post } = await mk();
    const r = await gate.verify(post('/v', { v: 1 }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('bad_request');
    expect((await gate.getAccess('')).ok).toBe(false);
    const bad = await gate.challenge(new Request(`${ORIGIN}/c`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }));
    expect(bad.status).toBe(403);
  });
});
