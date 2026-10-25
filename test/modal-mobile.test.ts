// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTouchDevice, pairingModal } from '../src/modal';
import { WEB_WALLET_URL } from '../src/element';

const LINK = 'https://www.bwallet.space/pair?v=1&r=relay.example&c=AAAAAAAAAAAAAAAAAAAAAA&k=02aa&o=https%3A%2F%2Fsite.example&e=9999999999';
const nav = (userAgent: string, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints }) as Navigator;
const mm = (coarse: boolean, hover: boolean) => (q: string) => ({ matches: q.includes('coarse') ? coarse : hover }) as MediaQueryList;

afterEach(() => document.querySelectorAll('.bwx-ov').forEach((e) => e.remove()));

describe('isTouchDevice', () => {
  it('phones and tablets are touch; desktops are not', () => {
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148') })).toBe(true);
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36') })).toBe(true);
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5) })).toBe(true); // iPadOS
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130', 0), matchMedia: mm(false, true) })).toBe(false);
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (X11; Linux x86_64)'), matchMedia: mm(true, false) })).toBe(true);
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (Windows NT 10.0) touch laptop'), matchMedia: mm(true, true) })).toBe(false);
    expect(isTouchDevice({})).toBe(false);
  });
});

describe('pairingModal on a phone', () => {
  it("mode 'app' shows Open bWalletX linking to the pairing universal link, and no QR", () => {
    const m = pairingModal({ mode: 'app' });
    m.onLink(LINK);
    expect(document.querySelector('.bwx-qr')).toBeNull();
    const open = document.querySelector('a.bwx-primary') as HTMLAnchorElement;
    expect(open.textContent).toBe('Open bWalletX');
    expect(open.getAttribute('href')).toBe(LINK);
    m.onCode('4821');
    expect(document.querySelector('.bwx-code')!.textContent).toBe('4821');
    m.close();
  });

  it('the web fallback copies the link and opens web.bwalletx.com', async () => {
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const m = pairingModal({ mode: 'app' });
    m.onLink(LINK);
    const web = Array.from(document.querySelectorAll('button.bwx-btn')).find((b) => b.textContent?.includes('web.bwalletx.com')) as HTMLButtonElement;
    web.click();
    expect(write).toHaveBeenCalledWith(LINK);
    expect(open).toHaveBeenCalledWith(WEB_WALLET_URL, '_blank', 'noopener');
    m.close();
  });

  it('cancel aborts in app mode; auto mode on a desktop still shows the QR', () => {
    const m = pairingModal({ mode: 'app' });
    m.onLink(LINK);
    (Array.from(document.querySelectorAll('button.bwx-btn')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement).click();
    expect(m.signal!.aborted).toBe(true);
    expect(document.querySelector('.bwx-ov')).toBeNull();

    const d = pairingModal({ mode: 'qr' });
    d.onLink(LINK);
    expect(document.querySelector('.bwx-qr svg')).not.toBeNull();
    expect(document.querySelector('a.bwx-primary')).toBeNull();
    d.close();
  });
});
