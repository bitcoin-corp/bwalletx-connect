// @vitest-environment happy-dom
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAuthorizeUrl, defineBwalletxSignin, signinText } from '../src/element';

type El = HTMLElement & { button: HTMLButtonElement; notFound: boolean };

function mount(attrs: Record<string, string> = {}): El {
  const el = document.createElement('bwalletx-signin') as El;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}
const text = (el: El) => el.shadowRoot!.textContent!.replace(/\s+/g, ' ');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => { defineBwalletxSignin(); });
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('<bwalletx-signin> render', () => {
  it('defaults to the gold lg "Sign in with bWalletX / also works with bWallet"', () => {
    const el = mount();
    expect(el.button.tagName).toBe('BUTTON');
    expect(el.button.type).toBe('button');
    expect(text(el)).toContain('Sign in with bWalletX');
    expect(text(el)).toContain('also works with bWallet');
    expect(el.button.getAttribute('aria-label')).toBe('Sign in with bWalletX, also works with bWallet');
    expect(el.shadowRoot!.querySelector('svg')).not.toBeNull();
  });

  it('label, brand and subtitle attributes change the text', () => {
    expect(text(mount({ label: 'continue' }))).toContain('Continue with bWalletX');
    expect(text(mount({ label: 'connect' }))).toContain('Connect bWalletX');
    const store = mount({ brand: 'bWallet' });
    expect(text(store)).toContain('Sign in with bWallet');
    expect(text(store)).not.toContain('also works');
    expect(text(mount({ subtitle: 'off' }))).not.toContain('also works');
    expect(text(mount({ subtitle: 'no extension needed' }))).toContain('no extension needed');
    expect(signinText('connect', 'bWallet')).toBe('Connect bWallet');
  });

  it('sm hides the subtitle; icon has no visible text but keeps an aria-label', () => {
    expect(text(mount({ size: 'sm' }))).not.toContain('also works');
    const icon = mount({ size: 'icon' });
    expect(icon.shadowRoot!.querySelector('.txt')).toBeNull();
    expect(icon.button.getAttribute('aria-label')).toBe('Sign in with bWalletX');
  });

  it('re-renders on attribute change; disabled and loading reach the button', () => {
    const el = mount();
    el.setAttribute('label', 'connect');
    expect(text(el)).toContain('Connect bWalletX');
    el.setAttribute('disabled', '');
    expect(el.button.disabled).toBe(true);
    el.removeAttribute('disabled');
    el.setAttribute('loading', '');
    expect(el.button.getAttribute('aria-busy')).toBe('true');
    expect(el.shadowRoot!.querySelector('.spin')).not.toBeNull();
  });

  it('escapes custom text', () => {
    const el = mount({ subtitle: '<img src=x onerror=alert(1)>' });
    expect(el.shadowRoot!.querySelector('img')).toBeNull();
  });
});

describe('<bwalletx-signin> events', () => {
  it('fires a composed, bubbling bwalletx-signin on click', () => {
    const el = mount();
    const seen = vi.fn();
    document.addEventListener('bwalletx-signin', seen);
    el.button.click();
    document.removeEventListener('bwalletx-signin', seen);
    expect(seen).toHaveBeenCalledTimes(1);
    const e = seen.mock.calls[0][0] as CustomEvent;
    expect(e.bubbles && e.composed && e.cancelable).toBe(true);
  });

  it('does not fire when disabled', () => {
    const el = mount({ disabled: '' });
    const seen = vi.fn();
    el.addEventListener('bwalletx-signin', seen);
    el.button.click();
    expect(seen).not.toHaveBeenCalled();
  });

  it('shows "Get bWalletX" and fires bwalletx-not-found when no wallet answers', async () => {
    const el = mount({ 'challenge-url': '/c', 'discover-ms': '20' });
    const nf = vi.fn();
    el.addEventListener('bwalletx-not-found', nf);
    el.button.click();
    await tick(80);
    expect(nf).toHaveBeenCalledTimes(1);
    const link = el.shadowRoot!.querySelector<HTMLAnchorElement>('.nf a')!;
    expect(link.textContent).toBe('Get bWalletX');
    expect(link.getAttribute('href')).toBe('https://bwalletx.com/get');
    expect(el.shadowRoot!.querySelectorAll('.nf a')[1].getAttribute('href')).toBe('https://web.bwalletx.com');
  });

  it('preventDefault on bwalletx-signin skips the built-in flow', async () => {
    const el = mount({ 'challenge-url': '/c', 'discover-ms': '20' });
    el.addEventListener('bwalletx-signin', (e) => e.preventDefault());
    el.button.click();
    await tick(60);
    expect(el.notFound).toBe(false);
  });

  it('runs challenge → sign → verify with an announced bWalletX and fires bwalletx-signed-in', async () => {
    const root = PrivateKey.fromRandom();
    const pw = new ProtoWallet(root);
    const wallet = {
      waitForAuthentication: async () => ({ authenticated: true }),
      getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => pw.getPublicKey(a),
      createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => pw.createSignature(a),
    } as unknown as WalletInterface;
    const announce = () => window.dispatchEvent(Object.assign(new Event('brc100:announceWallet'), { detail: { info: { rdns: 'com.bwalletx.extension' }, wallet } }));
    window.addEventListener('brc100:requestWallet', announce);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const body = url === '/c' ? { nonce: 'n1', message: 'hello', keyID: 'n1' } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const el = mount({ 'challenge-url': '/c', 'verify-url': '/v', 'discover-ms': '50' });
    const done = new Promise<CustomEvent>((r) => el.addEventListener('bwalletx-signed-in', (e) => r(e as CustomEvent)));
    el.button.click();
    const e = await done;
    window.removeEventListener('brc100:requestWallet', announce);
    vi.unstubAllGlobals();
    expect(calls).toEqual(['/c', '/v']);
    expect(e.detail.method).toBe('extension');
    expect(e.detail.identityKey).toBe(root.toPublicKey().toString());
    expect(e.detail.response).toEqual({ ok: true });
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds a code + S256 PKCE URL and stores the verifier', async () => {
    const u = new URL(await buildAuthorizeUrl({ authorizeUrl: 'https://auth.bwalletx.com/authorize', clientId: 'abc', redirectUri: 'https://x.test/cb' }));
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('abc');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('openid profile');
    const saved = JSON.parse(sessionStorage.getItem('bwalletx:oauth')!);
    expect(saved.state).toBe(u.searchParams.get('state'));
  });
});
