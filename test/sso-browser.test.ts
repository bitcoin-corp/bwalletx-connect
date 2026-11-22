// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bwxSso } from '../src/sso/browser';
import { decodeTx, pkceChallenge } from '../src/sso/shared';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function mockSession(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body));
}

describe('bwxSso', () => {
  it('signed out: Sign in with bWalletX + Get bWalletX in the [data-bwx-sso] slot', async () => {
    document.body.innerHTML = '<header><div data-bwx-sso></div></header>';
    mockSession({ signedIn: false });
    const s = bwxSso({ clientId: 'site', silent: false });
    await tick(5);
    const slot = document.querySelector('[data-bwx-sso]')!;
    expect(slot.querySelector('[data-bwx-sso-signin]')!.textContent).toBe('bSign in with bWalletX');
    expect(slot.querySelector('a')!.getAttribute('href')).toBe('https://bwalletx.com/get');
    s.destroy();
  });

  it('signed in: the account chip with paymail and both sign-out choices', async () => {
    document.body.innerHTML = '<div data-bwx-sso></div>';
    mockSession({ signedIn: true, identityKey: '02' + 'ab'.repeat(32), paymail: 'alice@bwalletx.com', tier: 'standard' });
    const s = bwxSso({ clientId: 'site', accountUrl: '/dashboard' });
    await tick(5);
    const chip = document.querySelector('[data-bwx-sso-chip]')!;
    expect(chip.textContent).toContain('alice@bwalletx.com');
    const items = Array.from(document.querySelectorAll(".bwx-sso-item")).map((e) => e.textContent);
    expect(items).toEqual(['Your page', 'Sign out of this site', 'Sign out of all b*X sites']);
    s.destroy();
  });

  it('bwx:signin does a top-level PKCE redirect with returnTo from ?returnTo=', async () => {
    history.replaceState(null, '', '/gate?returnTo=%2Fvault');
    mockSession({ signedIn: false });
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign, origin: window.location.origin, search: window.location.search, href: window.location.href, protocol: 'http:' } as Location);
    const s = bwxSso({ clientId: 'site', hub: 'https://id.example', silent: false });
    await tick(5);
    window.dispatchEvent(new Event('bwx:signin'));
    await tick(20);
    expect(assign).toHaveBeenCalledTimes(1);
    const u = new URL(assign.mock.calls[0][0]);
    expect(u.origin + u.pathname).toBe('https://id.example/authorize');
    expect(u.searchParams.get('client_id')).toBe('site');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe(window.location.origin + '/sso/callback');
    const state = u.searchParams.get('state')!;
    const raw = document.cookie.split('; ').find((c) => c.startsWith('bwx_sso_'))!;
    const tx = decodeTx(raw.slice(raw.indexOf('=') + 1))!;
    expect(tx.state).toBe(state);
    expect(tx.returnTo).toBe('/vault');
    expect(await pkceChallenge(tx.verifier)).toBe(u.searchParams.get('code_challenge'));
    s.destroy();
  });

  it('a crafted ?returnTo= that normalises to another host becomes "/" (open redirect)', async () => {
    for (const rt of ['/..//evil.com', '/%2e%2e//evil.com', '//evil.com', 'https://evil.com', '/\\evil.com']) {
      history.replaceState(null, '', `/gate?returnTo=${encodeURIComponent(rt)}`);
      document.cookie.split('; ').filter((c) => c.startsWith('bwx_sso_')).forEach((c) => (document.cookie = `${c.split('=')[0]}=; Max-Age=0; Path=/`));
      mockSession({ signedIn: false });
      const assign = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign, origin: window.location.origin, search: window.location.search, href: window.location.href, protocol: 'http:' } as Location);
      const s = bwxSso({ clientId: 'site', hub: 'https://id.example', silent: false });
      await tick(5);
      window.dispatchEvent(new Event('bwx:signin'));
      await tick(20);
      const state = new URL(assign.mock.calls[0][0]).searchParams.get('state')!;
      const raw = document.cookie.split('; ').find((c) => c.startsWith('bwx_sso_') && decodeTx(c.slice(c.indexOf('=') + 1))?.state === state)!;
      expect(decodeTx(raw.slice(raw.indexOf('=') + 1))!.returnTo, rt).toBe('/');
      s.destroy();
      vi.restoreAllMocks();
    }
  });
});
