import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { describe, expect, it, vi } from 'vitest';
import { PaymentVerificationError, verifyPayment } from '../src/verify-payment';

const payee = PrivateKey.fromRandom();
const other = PrivateKey.fromRandom();
const payeeAddr = payee.toAddress();

async function fixture() {
  const k = PrivateKey.fromRandom();
  const parent = new Transaction();
  parent.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(k.toAddress()), sequence: 0xffffffff });
  parent.addOutput({ lockingScript: new P2PKH().lock(k.toAddress()), satoshis: 10_000 });
  parent.merklePath = new MerklePath(1, [[{ offset: 0, hash: parent.id('hex'), txid: true }, { offset: 1, duplicate: true }]]);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
  tx.addOutput({ lockingScript: new P2PKH().lock(payeeAddr), satoshis: 1_000 });
  tx.addOutput({ lockingScript: new P2PKH().lock(other.toAddress()), satoshis: 500 });
  await tx.sign();
  return tx;
}

const fakeFetch = (routes: Record<string, { status?: number; body: unknown }>) =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    const r = Object.entries(routes).find(([k]) => u.endsWith(k));
    if (!r) return new Response('not found', { status: 404 });
    const b = r[1].body;
    return new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: r[1].status ?? 200 });
  }) as unknown as typeof fetch;

describe('verifyPayment', () => {
  it('accepts a raw tx paying the expected address', async () => {
    const tx = await fixture();
    const r = await verifyPayment({ tx: tx.toHex(), expected: [{ address: payeeAddr, satoshis: 1_000 }], status: 'none' });
    expect(r).toMatchObject({ ok: true, txid: tx.id('hex'), matched: [{ vout: 0, satoshis: 1_000 }], status: { state: 'unchecked' } });
  });

  it('accepts BEEF and Atomic BEEF, by script', async () => {
    const tx = await fixture();
    const script = new P2PKH().lock(other.toAddress()).toHex();
    for (const input of [tx.toHexBEEF(), tx.toAtomicBEEF()]) {
      const r = await verifyPayment({ tx: input, expected: [{ script, satoshis: 500 }], status: 'none' });
      expect(r.matched[0].vout).toBe(1);
    }
  });

  it('fails when the amount is short, the script is wrong, or one output is counted twice', async () => {
    const tx = await fixture();
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: PaymentVerificationError) => e.code);
    expect(await code(verifyPayment({ tx: tx.toHex(), expected: [{ address: payeeAddr, satoshis: 1_001 }], status: 'none' }))).toBe('OUTPUT_MISSING');
    expect(await code(verifyPayment({ tx: tx.toHex(), expected: [{ address: PrivateKey.fromRandom().toAddress(), satoshis: 1 }], status: 'none' }))).toBe('OUTPUT_MISSING');
    expect(
      await code(verifyPayment({ tx: tx.toHex(), expected: [{ address: payeeAddr, satoshis: 1 }, { address: payeeAddr, satoshis: 1 }], status: 'none' })),
    ).toBe('OUTPUT_MISSING');
    expect(await code(verifyPayment({ tx: 'zz', expected: [{ address: payeeAddr, satoshis: 1 }], status: 'none' }))).toBe('BAD_TX');
    expect(await code(verifyPayment({ tx: tx.toHex(), expected: [{ address: 'nope', satoshis: 1 }], status: 'none' }))).toBe('BAD_EXPECTED');
    expect(await code(verifyPayment({ tx: tx.toHex(), expected: [], status: 'none' }))).toBe('BAD_EXPECTED');
  });

  it('fetches a txid from WhatsOnChain and reads confirmations', async () => {
    const tx = await fixture();
    const id = tx.id('hex');
    const f = fakeFetch({ [`/tx/${id}/hex`]: { body: tx.toHex() }, [`/tx/hash/${id}`]: { body: { confirmations: 3 } } });
    const r = await verifyPayment({ tx: id, expected: [{ address: payeeAddr, satoshis: 1_000 }], minConfirmations: 2, fetch: f });
    expect(r.status).toEqual({ state: 'confirmed', confirmations: 3, source: 'woc' });
  });

  it('reports a missing txid, an unseen tx and an ARC rejection', async () => {
    const tx = await fixture();
    const id = tx.id('hex');
    const exp = [{ address: payeeAddr, satoshis: 1_000 }];
    await expect(verifyPayment({ tx: id, expected: exp, fetch: fakeFetch({}) })).rejects.toMatchObject({ code: 'TX_NOT_FOUND' });
    await expect(verifyPayment({ tx: tx.toHex(), expected: exp, requireSeen: true, fetch: fakeFetch({}) })).rejects.toMatchObject({ code: 'NOT_SEEN' });
    const arc = fakeFetch({ [`/v1/tx/${id}`]: { body: { txStatus: 'REJECTED', extraInfo: 'double spend' } } });
    await expect(verifyPayment({ tx: tx.toHex(), expected: exp, status: 'arc', arcUrl: 'https://arc.example', fetch: arc })).rejects.toMatchObject({ code: 'REJECTED' });
    const seen = fakeFetch({ [`/v1/tx/${id}`]: { body: { txStatus: 'SEEN_ON_NETWORK' } } });
    const r = await verifyPayment({ tx: tx.toHex(), expected: exp, status: 'arc', arcUrl: 'https://arc.example', requireSeen: true, fetch: seen });
    expect(r.status).toMatchObject({ state: 'mempool', source: 'arc' });
  });

  it('refuses a fetched tx whose id does not match', async () => {
    const tx = await fixture();
    const otherTx = await fixture();
    const id = tx.id('hex');
    await expect(
      verifyPayment({ tx: id, expected: [{ address: payeeAddr, satoshis: 1 }], fetch: fakeFetch({ [`/tx/${id}/hex`]: { body: otherTx.toHex() } }) }),
    ).rejects.toMatchObject({ code: 'BAD_TX' });
  });
});
