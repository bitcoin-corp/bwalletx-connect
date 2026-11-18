// @vitest-environment happy-dom
/**
 * Host apps on other @bsv/sdk versions than connect's own copy: 1.9.31 (b0ase.com today), 2.8.11, and 4.0.1 (a
 * different 4.x copy from connect's, as when an app's lockfile pins an older 4.x and pnpm cannot dedupe).
 * Everything a host makes is built with ITS copy (aliases '@bsv/sdk-v1' / '-v2' / '-v4'); connect's code imports
 * '@bsv/sdk' and gets its own. Nothing may depend on two copies sharing classes.
 */
import * as Own from '@bsv/sdk';
import * as V1 from '@bsv/sdk-v1';
import * as V2 from '@bsv/sdk-v2';
import * as V4 from '@bsv/sdk-v4';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/access';
import { proveHoldings, requestAccess } from '../src/access-client';
import { createAccessChallenge, verifyAccess } from '../src/access-server';
import { discoverBwalletX, XDM_RESPONSE_TIMEOUT_MS } from '../src/discover';
import { pay, tip } from '../src/pay';
import { createChallenge, memoryStore, verifySignIn } from '../src/server';
import { signInAndVerify, signInWithBwalletX, waitIfLocked, type SignInResult } from '../src/signin';
import { verifyPayment } from '../src/verify-payment';
import { brc100Option, cwiIsAnnounced } from '../src/wallets';
import { connectMetanetDesktop, metanetOption, trySilentMetanet } from '../src/metanet';
import { runSilentMetanet } from '../src/connect-flow';

const ORIGIN = 'https://b0ase.com';
const TOKEN = `bsv21:${'ab'.repeat(32)}_0`;

/**
 * Compile-time half of the test (tsc runs over test/): each host's own WalletInterface and ChainTracker fit every
 * public parameter that takes one. Never called.
 */
export function hostTypesFit(
  w1: V1.WalletInterface,
  w2: V2.WalletInterface,
  w4: V4.WalletInterface,
  own: Own.WalletInterface,
  c1: V1.ChainTracker,
  c2: V2.ChainTracker,
  c4: V4.ChainTracker,
) {
  const challenge = async () => ({ nonce: '', message: '', keyID: '' });
  for (const w of [w1, w2, w4, own]) {
    void signInWithBwalletX({ wallet: w, challenge });
    void waitIfLocked(w);
    void pay(w, { to: '', sats: 1 });
    void tip(w, { to: '', sats: 1 });
    void proveHoldings(w, '', '');
    void requestAccess({ wallet: w, challenge: async () => ({ challenge: '' }) });
    cwiIsAnnounced(w, [brc100Option(w, { id: '', name: '' })]);
    // 0.7.0's Metanet Desktop paths take a host-made wallet through `make`.
    const make = () => w;
    void metanetOption({ make });
    void connectMetanetDesktop({ make });
    void trySilentMetanet({ make });
    void runSilentMetanet({ make });
  }
  for (const spv of [c1, c2, c4]) void verifyPayment({ tx: '', expected: [], spv });
  // Known limit, the other way round: a wallet connect hands back is typed as connect's own (4.x) WalletInterface,
  // whose byte results may be Uint8Array; 1.9's type says number[]. Cast if you must pass it to 1.9-typed code.
  // @ts-expect-error 1.9 types BEEF / signature results as number[] only.
  const back1: V1.WalletInterface = own;
  const back4: V4.WalletInterface = own;
  return [back1, back4];
}

type Sdk = typeof V1; // the subset used below is the same in 1.9, 2.x and 4.x

const HOSTS: [string, Sdk][] = [
  ['1.9.31', V1],
  ['2.8.11', V2 as unknown as Sdk],
  ['4.0.1', V4 as unknown as Sdk],
];

/** A parent tx with a merkle path, so BEEF built on top of it is self-contained. */
function parentTx(S: Sdk, key: InstanceType<Sdk['PrivateKey']>, sats = 100_000) {
  const parent = new S.Transaction();
  parent.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new S.P2PKH().lock(key.toAddress()), sequence: 0xffffffff });
  parent.addOutput({ lockingScript: new S.P2PKH().lock(key.toAddress()), satoshis: sats });
  // Not at offset 0: that is the coinbase, which SPV refuses until 100 blocks deep.
  parent.merklePath = new S.MerklePath(1, [[{ offset: 0, hash: '11'.repeat(32) }, { offset: 1, hash: parent.id('hex'), txid: true }]]);
  return parent;
}

/**
 * The host's wallet, all host classes: ProtoWallet for keys and signatures, Transaction for createAction, a token
 * basket for listOutputs; wrapped in the host's own WalletClient, as such an app would.
 */
function hostWallet(S: Sdk, tokenKeyIDs: string[] = []) {
  const root = S.PrivateKey.fromRandom();
  const pw = new S.ProtoWallet(root);
  const funding = S.PrivateKey.fromRandom();
  const made: InstanceType<Sdk['Transaction']>[] = [];
  const substrate = {
    getPublicKey: (a: Parameters<V1.ProtoWallet['getPublicKey']>[0]) => pw.getPublicKey(a),
    createSignature: (a: Parameters<V1.ProtoWallet['createSignature']>[0]) => pw.createSignature(a),
    isAuthenticated: async () => ({ authenticated: true as const }),
    waitForAuthentication: async () => ({ authenticated: true as const }),
    async createAction(a: V1.CreateActionArgs) {
      const tx = new S.Transaction();
      tx.addInput({ sourceTransaction: parentTx(S, funding), sourceOutputIndex: 0, unlockingScriptTemplate: new S.P2PKH().unlock(funding) });
      for (const o of a.outputs ?? []) tx.addOutput({ lockingScript: S.LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis });
      await tx.sign();
      made.push(tx);
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() };
    },
    async listOutputs() {
      const outputs = [];
      for (const [i, keyID] of tokenKeyIDs.entries()) {
        const { publicKey } = await pw.getPublicKey({ protocolID: [0, 'onesat'], keyID, counterparty: 'self' });
        const h = S.Utils.toHex(S.Hash.hash160(S.Utils.toArray(publicKey, 'hex')));
        outputs.push({
          outpoint: `${'cd'.repeat(32)}.${i}`,
          satoshis: 1,
          spendable: true,
          lockingScript: `0063036f7264${'00'.repeat(4)}6876a914${h}88ac`,
          customInstructions: JSON.stringify({ id: TOKEN.replace('bsv21:', ''), amt: '100', keyID }),
        });
      }
      return { totalOutputs: outputs.length, outputs };
    },
  };
  const wallet: V1.WalletInterface = new S.WalletClient(substrate as unknown as V1.WalletInterface, 'b0ase.com');
  return { wallet, root, made };
}

describe.each(HOSTS)('host on @bsv/sdk %s', (version, S) => {
  it('really is a separate copy from connect’s', () => {
    expect((S as unknown as { Transaction: unknown }).Transaction).not.toBe(Own.Transaction);
    expect((S as unknown as { WalletClient: unknown }).WalletClient).not.toBe(Own.WalletClient);
  });

  describe('sign-in', () => {
    it('the host’s WalletClient signs in through connect and connect/server verifies it', async () => {
      const { wallet, root } = hostWallet(S);
      expect(wallet).toBeInstanceOf(S.WalletClient);
      const store = memoryStore({ quiet: true });
      const r: SignInResult = await signInWithBwalletX({
        wallet, // the host's WalletInterface where connect's is expected: structural, no class check
        skipWaitForAuthentication: true,
        challenge: (identityKey) => createChallenge({ origin: ORIGIN, identityKey, store }),
      });
      expect(r.method).toBe('wallet');
      expect(r.wallet).toBe(wallet); // handed back untouched
      expect(r.identityKey).toBe(root.toPublicKey().toString());
      // The wire form survives JSON, as it would posting to the verify route.
      const body = JSON.parse(JSON.stringify({ identityKey: r.identityKey, nonce: r.nonce, signature: r.signature }));
      expect(await verifySignIn({ origin: ORIGIN, store, ...body })).toBe(r.identityKey);
    });

    it('one-sheet order (keyless challenge) and signInAndVerify', async () => {
      const { wallet, root } = hostWallet(S);
      const store = memoryStore({ quiet: true });
      const { verified } = await signInAndVerify({
        wallet,
        skipWaitForAuthentication: true,
        challenge: () => createChallenge({ origin: ORIGIN, store }),
        verify: async (r) => ({ id: await verifySignIn({ origin: ORIGIN, store, identityKey: r.identityKey, nonce: r.nonce, signature: r.signature }) }),
      });
      expect(verified.id).toBe(root.toPublicKey().toString());
    });

    it('a signature made with host primitives directly (no wallet) verifies on connect/server', async () => {
      const root = S.PrivateKey.fromRandom();
      const store = memoryStore({ quiet: true });
      const identityKey = root.toPublicKey().toString();
      const c = await createChallenge({ origin: ORIGIN, identityKey, store });
      const { signature } = await new S.ProtoWallet(root).createSignature({
        protocolID: c.protocolID,
        keyID: c.keyID,
        counterparty: 'anyone',
        data: S.Utils.toArray(c.message, 'utf8'),
      });
      expect(await verifySignIn({ origin: ORIGIN, store, identityKey, nonce: c.nonce, signature: Array.from(signature) })).toBe(identityKey);
    });
  });

  describe('payments', () => {
    const payee = S.PrivateKey.fromRandom();
    const payeeAddr = payee.toAddress();

    it('pay() with the host’s WalletClient; connect/server verifies the Atomic BEEF, BEEF and raw tx', async () => {
      const { wallet, made } = hostWallet(S);
      const r = await pay(wallet, { to: payeeAddr, sats: 1_000 }, {});
      expect(Array.isArray(r.tx)).toBe(true);
      const hostTx = made[0];
      expect(r.txid).toBe(hostTx.id('hex'));
      const expected = [{ address: payeeAddr, satoshis: 1_000 }];
      const forms = [r.tx!, S.Utils.toHex(r.tx!), hostTx.toHexBEEF(), Array.from(hostTx.toBEEF()), hostTx.toHex(), Uint8Array.from(hostTx.toBinary())];
      for (const tx of forms) {
        const v = await verifyPayment({ tx, expected, status: 'none' });
        expect(v).toMatchObject({ ok: true, txid: r.txid, matched: [{ vout: 0, satoshis: 1_000 }] });
      }
    });

    it('SPV with the host’s chain tracker type on a BEEF the host built', async () => {
      const { wallet } = hostWallet(S);
      const r = await tip(wallet, { to: payeeAddr, sats: 500 }, {});
      const roots: [string, number][] = [];
      const tracker: V1.ChainTracker = {
        isValidRootForHeight: async (root, height) => (roots.push([root, height]), true),
        currentHeight: async () => 2,
      };
      const expected = [{ address: payeeAddr, satoshis: 500 }];
      expect((await verifyPayment({ tx: r.tx!, expected, status: 'none', spv: tracker })).ok).toBe(true);
      expect(roots).toEqual([[expect.any(String), 1]]);
      const no: V1.ChainTracker = { isValidRootForHeight: async () => false, currentHeight: async () => 2 };
      await expect(verifyPayment({ tx: r.tx!, expected, status: 'none', spv: no })).rejects.toMatchObject({ code: 'SPV_FAILED' });
    });

    it('BRC-29 pay to an identity key: the key the host wallet derives locks the output', async () => {
      const { wallet, root } = hostWallet(S);
      const recipient = S.PrivateKey.fromRandom();
      const r = await pay(wallet, { to: recipient.toPublicKey().toString(), sats: 700 }, {});
      expect(r.remittance?.senderIdentityKey).toBe(root.toPublicKey().toString());
      // The recipient derives the same key from the remittance.
      const { publicKey } = await new S.ProtoWallet(recipient).getPublicKey({
        protocolID: [2, '3241645161d8'],
        keyID: `${r.remittance!.derivationPrefix} ${r.remittance!.derivationSuffix}`,
        counterparty: r.remittance!.senderIdentityKey,
        forSelf: true,
      });
      const script = new S.P2PKH().lock(S.PublicKey.fromString(publicKey).toAddress()).toHex();
      expect(r.outputs[0].script).toBe(script);
      expect((await verifyPayment({ tx: r.tx!, expected: [{ script, satoshis: 700 }], status: 'none' })).ok).toBe(true);
    });
  });

  describe('access (403 token gate)', () => {
    it('holding proofs signed by the host wallet verify on connect/server', async () => {
      const { wallet } = hostWallet(S, ['k1', 'k2']);
      const addrs: string[] = [];
      for (const keyID of ['k1', 'k2']) {
        const { publicKey } = await wallet.getPublicKey({ protocolID: [0, 'onesat'], keyID, counterparty: 'self' });
        addrs.push(S.PublicKey.fromString(publicKey).toAddress());
      }
      const store = memoryStore({ quiet: true });
      const require = { token: { id: TOKEN, min: '150' } };
      const resolver = { tokenBalance: async (_: string, a: string[]) => String(a.filter((x) => addrs.includes(x)).length * 100) };
      const { verified } = await requestAccess({
        wallet,
        challenge: async (identityKey) => createAccessChallenge({ origin: ORIGIN, require, store, identityKey }),
        verify: (response) => verifyAccess({ origin: ORIGIN, response: JSON.parse(canonicalJson(response)), store, resolver, require }),
      });
      expect(verified).toMatchObject({ ok: true, addresses: [...addrs].sort(), have: { tokenRaw: '200' } });
    });
  });
});

describe('host on @bsv/sdk 1.9.31: b0ase.com’s signing workaround', () => {
  it('a tx signed against a stand-in source tx (1.9 allows it, 2.x+ refuses) still verifies as a raw tx', async () => {
    const payeeAddr = V1.PrivateKey.fromRandom().toAddress();
    const k = V1.PrivateKey.fromRandom();
    const standIn = new V1.Transaction();
    standIn.addOutput({ lockingScript: new V1.P2PKH().lock(k.toAddress()), satoshis: 5_000 });
    const tx = new V1.Transaction();
    // sourceTXID is the real (here: made-up) parent; sourceTransaction only carries the spent output.
    tx.addInput({ sourceTXID: 'ef'.repeat(32), sourceOutputIndex: 0, sourceTransaction: standIn, unlockingScriptTemplate: new V1.P2PKH().unlock(k) });
    tx.addOutput({ lockingScript: new V1.P2PKH().lock(payeeAddr), satoshis: 2_000 });
    await tx.sign();
    const v = await verifyPayment({ tx: tx.toHex(), expected: [{ address: payeeAddr, satoshis: 2_000 }], status: 'none' });
    expect(v.txid).toBe(tx.id('hex'));
  });
});

describe('in the bWalletX frame, the wallet is connect’s own @bsv/sdk WalletClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A bWalletX parent frame. `answer` returns the result for a call, or undefined to never answer. */
  function parentFrame(answer: (call: string) => unknown) {
    const origin = 'capacitor://localhost';
    Object.defineProperty(document, 'referrer', { value: `${origin}/`, configurable: true });
    const parent = { postMessage: vi.fn() };
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
    parent.postMessage.mockImplementation((msg: { id: string; call: string }) => {
      const result = answer(msg.call);
      if (result === undefined) return;
      const ev = new MessageEvent('message', { data: { type: 'CWI', isInvocation: false, id: msg.id, status: 'success', result }, origin });
      Object.defineProperty(ev, 'source', { value: parent });
      Object.defineProperty(ev, 'isTrusted', { value: true });
      queueMicrotask(() => window.dispatchEvent(ev));
    });
    return parent;
  }
  const authOnly = (call: string) => (call === 'isAuthenticated' ? { authenticated: true } : undefined);

  it('is connect’s WalletClient over connect’s XDM with a response timeout, never a host class', async () => {
    parentFrame(authOnly);
    const found = await discoverBwalletX(50);
    expect(found?.method).toBe('in-app');
    expect(found!.wallet).toBeInstanceOf(Own.WalletClient);
    for (const S of [V1, V2, V4]) expect(found!.wallet).not.toBeInstanceOf(S.WalletClient);
    const substrate = (found!.wallet as unknown as { substrate: unknown }).substrate;
    expect(substrate).toBeInstanceOf(Own.XDM);
    expect((substrate as { responseTimeout?: number }).responseTimeout).toBe(XDM_RESPONSE_TIMEOUT_MS);
  });

  it('validates answers: a malformed getPublicKey answer is refused (1.9 passes it through)', async () => {
    parentFrame((call) => authOnly(call) ?? (call === 'getPublicKey' ? { publicKey: 'not-a-key' } : undefined));
    const found = await discoverBwalletX(50);
    await expect(found!.wallet.getPublicKey({ identityKey: true })).rejects.toThrow();
    // Contrast: a 1.9 app's own XDM client accepts the same answer.
    const v1 = new V1.WalletClient(new V1.XDM('capacitor://localhost') as unknown as V1.WalletInterface);
    await expect(v1.getPublicKey({ identityKey: true })).resolves.toEqual({ publicKey: 'not-a-key' });
  });

  it('validates createAction answers (a txid that is not a txid is refused; pay() says it may have been sent)', async () => {
    parentFrame((call) => authOnly(call) ?? (call === 'createAction' ? { txid: 'zz' } : undefined));
    const found = await discoverBwalletX(50);
    const err = await pay(found!.wallet, { to: V1.PrivateKey.fromRandom().toAddress(), sats: 1 }, {}).catch((e) => e);
    expect(err).toMatchObject({ name: 'PaymentError', code: 'WALLET_ERROR', maybeSent: true });
  });

  it('times out a call the parent never answers', async () => {
    parentFrame(authOnly);
    const found = await discoverBwalletX(50);
    vi.useFakeTimers();
    const p = pay(found!.wallet, { to: V1.PrivateKey.fromRandom().toAddress(), sats: 1 }, {}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(XDM_RESPONSE_TIMEOUT_MS + 1);
    const err = await p;
    expect(err).toMatchObject({ code: 'WALLET_ERROR', maybeSent: true });
    expect(String(err.cause?.message)).toMatch(/timed out/);
  });
});
