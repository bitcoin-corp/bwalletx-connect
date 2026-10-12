import { P2PKH, PrivateKey, ProtoWallet, PublicKey, type WalletInterface } from '@bsv/sdk';
import { describe, expect, it, vi } from 'vitest';
import { BRC29_PROTOCOL, PaymentError, amountInSats, buyToken, pay, tip } from '../src/pay';

const me = PrivateKey.fromRandom();

function fakeWallet(createAction: WalletInterface['createAction'] = vi.fn(async () => ({ txid: 'ab'.repeat(32) }))) {
  const pw = new ProtoWallet(me);
  return {
    createAction,
    getPublicKey: (a: Parameters<WalletInterface['getPublicKey']>[0]) => pw.getPublicKey(a),
  } as unknown as WalletInterface & { createAction: ReturnType<typeof vi.fn> };
}

describe('pay', () => {
  it('pays an address with one createAction and an optional OP_RETURN memo', async () => {
    const w = fakeWallet();
    const to = PrivateKey.fromRandom().toAddress();
    const r = await pay(w, { to, sats: 1234, memo: 'hi', memoOnChain: true });
    expect(w.createAction).toHaveBeenCalledTimes(1);
    const args = w.createAction.mock.calls[0][0];
    expect(args.outputs[0]).toMatchObject({ lockingScript: new P2PKH().lock(to).toHex(), satoshis: 1234 });
    expect(args.outputs[1]).toMatchObject({ satoshis: 0, lockingScript: '006a026869' });
    expect(args.description.length).toBeGreaterThanOrEqual(5);
    expect(r).toMatchObject({ txid: 'ab'.repeat(32), sats: 1234 });
  });

  it('pays an identity key with a BRC-29 derived output and returns the remittance', async () => {
    const w = fakeWallet();
    const recipient = PrivateKey.fromRandom();
    const r = await pay(w, { to: recipient.toPublicKey().toString(), sats: 50 });
    const { derivationPrefix, derivationSuffix, senderIdentityKey } = r.remittance!;
    expect(senderIdentityKey).toBe(me.toPublicKey().toString());
    // The recipient can derive the same key from their side.
    const { publicKey } = await new ProtoWallet(recipient).getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: senderIdentityKey,
      forSelf: true,
    });
    expect(r.outputs[0].script).toBe(new P2PKH().lock(PublicKey.fromString(publicKey).toHash() as number[]).toHex());
  });

  it('converts usd, and validates amounts', async () => {
    expect(await amountInSats({ usd: 0.01 }, { usdPerBsv: 50 })).toBe(20_000);
    await expect(amountInSats({ sats: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(amountInSats({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(pay(fakeWallet(), { to: 'not a thing', sats: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('resolves a paymail through the injected resolver', async () => {
    const w = fakeWallet();
    const script = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();
    const r = await pay(w, { to: 'bob@example.com', sats: 10 }, { resolvePaymail: async () => ({ outputs: [{ script, satoshis: 10 }] }) });
    expect(r.outputs[0].script).toBe(script);
  });

  it('never retries: a declined or failed spend throws once', async () => {
    const declined = fakeWallet(vi.fn(async () => Promise.reject(new Error('User denied the request'))));
    const e = await pay(declined, { to: PrivateKey.fromRandom().toAddress(), sats: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(PaymentError);
    expect(e).toMatchObject({ code: 'WALLET_REJECTED', maybeSent: false });
    expect(declined.createAction).toHaveBeenCalledTimes(1);
    const broken = fakeWallet(vi.fn(async () => Promise.reject(new Error('socket hang up'))));
    await expect(pay(broken, { to: PrivateKey.fromRandom().toAddress(), sats: 1 })).rejects.toMatchObject({ code: 'WALLET_ERROR', maybeSent: true });
    expect(broken.createAction).toHaveBeenCalledTimes(1);
  });

  it('tip labels the action; a legacy payer is used as-is', async () => {
    const w = fakeWallet();
    await tip(w, { to: PrivateKey.fromRandom().toAddress(), sats: 5 });
    expect(w.createAction.mock.calls[0][0].labels).toContain('tip');
    const legacy = { pay: vi.fn(async (r: { sats: number }) => ({ txid: 'cd'.repeat(32), sats: r.sats, outputs: [] })) };
    expect(await pay(legacy, { to: '$alice', sats: 7 })).toMatchObject({ sats: 7 });
  });
});

describe('buyToken', () => {
  it('uses the quote hook, pays once and calls onPaid', async () => {
    const w = fakeWallet();
    const script = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();
    const onPaid = vi.fn();
    const r = await buyToken(w, { token: '$BOASE', amount: 100, quote: async () => ({ outputs: [{ script, satoshis: 300 }, { script, satoshis: 20 }], onPaid }) });
    expect(r.sats).toBe(320);
    expect(onPaid).toHaveBeenCalledWith(expect.objectContaining({ txid: 'ab'.repeat(32) }));
    expect(w.createAction.mock.calls[0][0].labels).toContain('token-buy');
  });
});
