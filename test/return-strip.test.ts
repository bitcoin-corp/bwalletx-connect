// @vitest-environment happy-dom
/**
 * Review 3 (22 Nov 2026): a return fragment (#bwx=ok&rid=…&wk=…&f=…) must be gone from the address bar before any
 * script that loads after connect can read it (history sync, analytics, session replay). Connect strips it
 * synchronously when its module loads, and keeps it in memory for resumeReturnedPairing.
 */
import { describe, expect, it, vi } from 'vitest';

describe('return fragment stripped at module load', () => {
  it('the hash is gone by the time the next script runs, and connect still has it', async () => {
    history.replaceState(null, '', '/rooms/lounge#bwx=ok&rid=AAAAAAAAAAAAAAAAAAAAAA&wk=02aa&f=xx');
    expect(location.hash).toContain('bwx=ok');
    vi.resetModules();
    const pair = await import('../src/pair');
    // "The next script": runs right after connect's module evaluated.
    expect(location.hash).toBe('');
    expect(location.pathname).toBe('/rooms/lounge');
    expect(pair.hasReturnFragment()).toBe(true);
  });

  it('a return landing later as a hash change is stripped by connect before other listeners see it', async () => {
    history.replaceState(null, '', '/');
    vi.resetModules();
    const pair = await import('../src/pair');
    let seen = 'unset';
    window.addEventListener('hashchange', () => (seen = location.hash)); // a third-party listener, added after connect
    location.hash = '#bwx=ok&rid=BBBBBBBBBBBBBBBBBBBBBB';
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toBe('');
    expect(pair.hasReturnFragment()).toBe(true);
  });

  it('other hashes are left alone', async () => {
    history.replaceState(null, '', '/#section-2');
    vi.resetModules();
    await import('../src/pair');
    expect(location.hash).toBe('#section-2');
  });
});
