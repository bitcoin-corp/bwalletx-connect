// @vitest-environment happy-dom
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import { describe, expect, it } from 'vitest';
import { discoverWallets, handcashAdapter } from '../src/wallets';
import { pairingModal, pickWallet } from '../src/modal';

const wallet = () => {
  const pw = new ProtoWallet(PrivateKey.fromRandom());
  return { getPublicKey: (a: never) => pw.getPublicKey(a), waitForAuthentication: async () => ({ authenticated: true }) } as unknown as WalletInterface;
};

function announce(rdns: string, name: string) {
  const w = wallet();
  window.addEventListener('brc100:requestWallet', () =>
    window.dispatchEvent(new CustomEvent('brc100:announceWallet', { detail: { info: { rdns, name }, wallet: w } })),
  );
}

describe('discoverWallets', () => {
  it('lists every announcing BRC-100 wallet, bWalletX first, HandCash adapter last', async () => {
    announce('io.yours', 'Yours');
    announce('com.bwalletx.extension', 'whatever');
    const hc = handcashAdapter({ login: async () => ({ handle: '$alice' }) });
    const list = await discoverWallets({ ms: 20, extra: [hc] });
    expect(list.map((w) => w.id)).toEqual(['com.bwalletx.extension', 'io.yours', 'handcash']);
    expect(list[0].name).toBe('bWalletX');
    const cw = await list[1].connect();
    expect(cw.identityKey).toMatch(/^0[23][0-9a-f]{64}$/);
    const h = await list[2].connect();
    expect(h).toMatchObject({ wallet: null, handle: '$alice', paymail: 'alice@handcash.io', transitional: true });
  });

  it('the picker resolves with the clicked option, the QR modal renders and cancels', async () => {
    const hc = handcashAdapter({ login: async () => ({ handle: 'x' }) });
    const p = pickWallet([hc]);
    (document.querySelector('.bwx-opt') as HTMLButtonElement).click();
    expect(await p).toBe(hc);

    const m = pairingModal();
    m.onLink('https://www.bwallet.space/pair#test');
    expect(document.querySelector('.bwx-qr svg')).not.toBeNull();
    m.onCode('1234');
    expect(document.querySelector('.bwx-code')!.textContent).toBe('1234');
    (document.querySelectorAll('.bwx-box .bwx-btn')[1] as HTMLButtonElement).click();
    expect(m.signal!.aborted).toBe(true);
    expect(document.querySelector('.bwx-ov')).toBeNull();
  });
});
