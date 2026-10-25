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

  const answering = (origin: string) => {
    const parent = { postMessage: vi.fn() };
    vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
    parent.postMessage.mockImplementation((msg: { id: string }) => {
      const ev = new MessageEvent('message', {
        data: { type: 'CWI', isInvocation: false, id: msg.id, status: 'success', result: { authenticated: true } },
        origin,
      });
      Object.defineProperty(ev, 'source', { value: parent });
      Object.defineProperty(ev, 'isTrusted', { value: true });
      queueMicrotask(() => window.dispatchEvent(ev));
    });
    return parent;
  };
  const parentIs = (origin: string) =>
    Object.defineProperty(document, 'referrer', { value: `${origin}/`, configurable: true });

  it('ATTACK: a parent that is not bWalletX is never asked, even if it would answer', async () => {
    parentIs('https://evil.example');
    const parent = answering('https://evil.example');
    const { discoverBwalletX } = await import('../src/discover');
    expect(await discoverBwalletX(30)).toBeNull();
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('ATTACK: an answer from another origin than the bWalletX parent is ignored', async () => {
    parentIs('capacitor://localhost');
    answering('https://evil.example');
    const { discoverBwalletX } = await import('../src/discover');
    expect(await discoverBwalletX(30)).toBeNull();
  });

  it('asks the bWalletX parent at its exact origin', async () => {
    parentIs('capacitor://localhost');
    const parent = answering('capacitor://localhost');
    const { discoverBwalletX } = await import('../src/discover');
    expect((await discoverBwalletX(50))?.method).toBe('in-app');
    expect(parent.postMessage.mock.calls[0][1]).toBe('capacitor://localhost');
  });

  it('uses XDM when framed and the parent answers', async () => {
    parentIs('capacitor://localhost');
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
