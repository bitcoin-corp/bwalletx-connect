// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('discoverBwalletX in the bWalletX in-wallet frame', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null at the top level when nothing is injected (no XDM probe)', async () => {
    const { discoverBwalletX } = await import('../src/discover');
    const post = vi.spyOn(window, 'postMessage');
    expect(await discoverBwalletX(20)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('uses XDM when framed and the parent answers', async () => {
    const parent = { postMessage: vi.fn() };
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
    parent.postMessage.mockImplementation((msg: { id: string }) => {
      const ev = new MessageEvent('message', {
        data: { type: 'CWI', isInvocation: false, id: msg.id, status: 'success', result: { authenticated: true } },
        origin: 'capacitor://localhost',
      });
      Object.defineProperty(ev, 'source', { value: parent });
      Object.defineProperty(ev, 'isTrusted', { value: true });
      queueMicrotask(() => window.dispatchEvent(ev));
    });
    const { discoverBwalletX } = await import('../src/discover');
    const found = await discoverBwalletX(50);
    expect(found?.method).toBe('in-app');
    expect(parent.postMessage).toHaveBeenCalled();
  });

  it('returns null when framed but the parent never answers', async () => {
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: vi.fn() } as unknown as Window);
    const { discoverBwalletX } = await import('../src/discover');
    expect(await discoverBwalletX(30)).toBeNull();
  });
});
