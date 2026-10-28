// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WalletInterface } from '@bsv/sdk';
import { DEFAULT_DISCOVER_MS, discoverBwalletX, prewarmBwalletX } from '../src/discover';
import { connectBwalletX } from '../src/signin';

const w = window as unknown as { CWI?: unknown };
const announce = (wallet: unknown) => {
  const on = () => window.dispatchEvent(new CustomEvent('brc100:announceWallet', { detail: { info: { rdns: 'com.bwalletx.extension' }, wallet } }));
  window.addEventListener('brc100:requestWallet', on);
  return () => window.removeEventListener('brc100:requestWallet', on);
};

describe('fast connect (latency budget)', () => {
  afterEach(() => {
    delete w.CWI;
    vi.restoreAllMocks();
  });

  it('defaults to a short wait', () => expect(DEFAULT_DISCOVER_MS).toBeLessThanOrEqual(300));

  it('resolves the extension at once, without waiting for the timeout', async () => {
    const off = announce({ isAuthenticated: async () => ({ authenticated: true }) });
    const t = performance.now();
    const f = await discoverBwalletX(5000);
    off();
    expect(f?.method).toBe('extension');
    expect(performance.now() - t).toBeLessThan(50);
  });

  it('takes window.CWI at once (in-app browser)', async () => {
    w.CWI = {};
    const t = performance.now();
    expect((await discoverBwalletX(5000))?.method).toBe('in-app');
    expect(performance.now() - t).toBeLessThan(50);
  });

  it('gives up after the short default when nothing is there', async () => {
    const t = performance.now();
    expect(await discoverBwalletX()).toBeNull();
    expect(performance.now() - t).toBeLessThan(DEFAULT_DISCOVER_MS + 150);
  });

  it('reports finding then opening', async () => {
    const off = announce({});
    const seen: string[] = [];
    const r = await connectBwalletX({ onStatus: (s) => seen.push(s) });
    off();
    expect(r.method).toBe('extension');
    expect(seen).toEqual(['finding', 'opening']);
  });

  it('prewarm sends a prompt-free liveness call to the extension, once', async () => {
    const isAuthenticated = vi.fn(async () => ({ authenticated: true }));
    const off = announce({ isAuthenticated } as unknown as WalletInterface);
    prewarmBwalletX();
    prewarmBwalletX();
    await new Promise((r) => setTimeout(r, 10));
    off();
    expect(isAuthenticated).toHaveBeenCalledTimes(1);
  });
});
