// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { START_URL, appPairLink, isPhoneWithoutWallet, isTouchDevice, pairingModal } from '../src/modal';

const LINK = 'https://www.bwallet.space/pair?v=1&r=relay.example&c=AAAAAAAAAAAAAAAAAAAAAA&k=02aa&o=https%3A%2F%2Fsite.example&e=9999999999';
const APP_LINK = 'bwalletx://pair?v=1&r=relay.example&c=AAAAAAAAAAAAAAAAAAAAAA&k=02aa&o=https%3A%2F%2Fsite.example&e=9999999999';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const nav = (userAgent: string, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints }) as Navigator;
const mm = (coarse: boolean, hover: boolean) => (q: string) => ({ matches: q.includes('coarse') ? coarse : hover }) as MediaQueryList;
const buttons = () => Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
const button = (text: string) => buttons().find((b) => b.textContent === text)!;
const sheetText = () => document.querySelector('.bwx-box')?.textContent ?? '';

afterEach(() => {
  document.querySelectorAll('.bwx-ov').forEach((e) => e.remove());
  vi.unstubAllGlobals();
});

describe('isTouchDevice', () => {
  it('phones and tablets are touch; desktops are not', () => {
    expect(isTouchDevice({ navigator: nav(IPHONE) })).toBe(true);
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36') })).toBe(true);
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5) })).toBe(true); // iPadOS
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130', 0), matchMedia: mm(false, true) })).toBe(false);
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (X11; Linux x86_64)'), matchMedia: mm(true, false) })).toBe(true);
    expect(isTouchDevice({ navigator: nav('Mozilla/5.0 (Windows NT 10.0) touch laptop'), matchMedia: mm(true, true) })).toBe(false);
    expect(isTouchDevice({})).toBe(false);
  });
});

describe('isPhoneWithoutWallet', () => {
  it('a phone or tablet browser with no wallet in the page', () => {
    expect(isPhoneWithoutWallet({ navigator: nav(IPHONE) })).toBe(true); // @photokuro: Safari on iPhone
    expect(isPhoneWithoutWallet({ navigator: nav('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36') })).toBe(true);
    expect(isPhoneWithoutWallet({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5) })).toBe(true); // iPadOS
    // No mobile UA: touch plus a narrow viewport.
    expect(isPhoneWithoutWallet({ navigator: nav('Mozilla/5.0 (X11; Linux x86_64)', 5), innerWidth: 412 })).toBe(true);
    expect(isPhoneWithoutWallet({ navigator: nav('Mozilla/5.0 (X11; Linux x86_64)'), matchMedia: mm(true, false), innerWidth: 390 })).toBe(true);
  });
  it('not a desktop, a wide touch laptop, or a page that already has a wallet (bWalletX in-app browser)', () => {
    expect(isPhoneWithoutWallet({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130'), matchMedia: mm(false, true), innerWidth: 1440 })).toBe(false);
    expect(isPhoneWithoutWallet({ navigator: nav('Mozilla/5.0 (Windows NT 10.0)', 10), innerWidth: 1920 })).toBe(false);
    expect(isPhoneWithoutWallet({ navigator: nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130'), innerWidth: 500 })).toBe(false); // narrow, no touch
    expect(isPhoneWithoutWallet({ navigator: nav(IPHONE), CWI: {} })).toBe(false);
    expect(isPhoneWithoutWallet({})).toBe(false);
  });
});

describe('appPairLink', () => {
  it('turns the https pairing link into the bwalletx:// scheme with the same parameters', () => {
    expect(appPairLink(LINK)).toBe(APP_LINK);
    // The wallet rebuilds the https link from these parameters (bWalletX src/mobile/pair/links.ts pairLinkFrom).
    expect(new URL(appPairLink(LINK)).searchParams.toString()).toBe(new URL(LINK).searchParams.toString());
  });
});

describe('pairingModal on a phone', () => {
  it("the primary action is a big gold Open in bWalletX through the app scheme; no QR until asked", () => {
    const m = pairingModal({ mode: 'app' });
    m.onLink(LINK);
    const open = document.querySelector('a.bwx-primary') as HTMLAnchorElement;
    expect(open.textContent).toBe('Open in bWalletX');
    expect(open.getAttribute('href')).toBe(APP_LINK);
    const get = Array.from(document.querySelectorAll('a')).find((a) => a.textContent === "Don't have it? Get bWalletX") as HTMLAnchorElement;
    expect(get.getAttribute('href')).toBe(START_URL);
    expect(START_URL).toBe('https://bwalletx.com/start');
    // The QR exists only behind "Show a QR for another device".
    const more = document.querySelector('.bwx-more') as HTMLElement;
    expect(more.hidden).toBe(true);
    button('Show a QR for another device').click();
    expect(more.hidden).toBe(false);
    expect(more.querySelector('.bwx-qr svg')).not.toBeNull();
    button('Hide the QR').click();
    expect(more.hidden).toBe(true);
    m.onCode('4821');
    expect(document.querySelector('.bwx-code')!.textContent).toBe('4821');
    m.close();
  });

  it("never tells someone on a phone to scan with the phone's camera", () => {
    const m = pairingModal({ mode: 'app' });
    m.onLink(LINK);
    expect(sheetText()).not.toMatch(/camera/i);
    expect(sheetText()).not.toMatch(/scan with your phone/i);
    m.onCode('4821');
    expect(sheetText()).not.toMatch(/camera/i);
    m.close();
  });

  it("auto mode picks the app sheet on an iPhone (Safari, no window.CWI) and asks for a longer pairing window", () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: IPHONE, maxTouchPoints: 5 });
    const m = pairingModal();
    expect(m.lifetimeS).toBe(240);
    m.onLink(LINK);
    expect((document.querySelector('a.bwx-primary') as HTMLAnchorElement).getAttribute('href')).toBe(APP_LINK);
    expect(document.querySelector('.bwx-more')).not.toBeNull();
    m.close();
  });

  it('auto mode in a page with a wallet (window.CWI) keeps the QR sheet', () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: IPHONE, maxTouchPoints: 5 });
    vi.stubGlobal('CWI', {});
    const m = pairingModal();
    m.onLink(LINK);
    expect(document.querySelector('a.bwx-primary')).toBeNull();
    expect(document.querySelector('.bwx-qr svg')).not.toBeNull();
    m.close();
  });

  it('cancel aborts in app mode; qr mode (desktop) still shows the QR first', () => {
    const m = pairingModal({ mode: 'app' });
    m.onLink(LINK);
    button('Cancel').click();
    expect(m.signal!.aborted).toBe(true);
    expect(document.querySelector('.bwx-ov')).toBeNull();

    const d = pairingModal({ mode: 'qr' });
    expect(d.lifetimeS).toBeUndefined();
    d.onLink(LINK);
    expect(document.querySelector('.bwx-qr svg')).not.toBeNull();
    expect(document.querySelector('a.bwx-primary')).toBeNull();
    expect(sheetText()).not.toMatch(/camera/i);
    d.close();
  });
});

describe('pairingModal: failure and success', () => {
  it('a failed round shows the error with Try again (true) or Cancel (false)', async () => {
    const m = pairingModal({ mode: 'app' });
    m.onLink(LINK);
    const again = m.retry!(new Error('The pairing code expired. Show a new one.'));
    expect(sheetText()).toContain('The pairing code expired');
    button('Try again').click();
    await expect(again).resolves.toBe(true);
    expect(document.querySelector('.bwx-ov')).toBeNull();

    const give = m.retry!(new Error('Could not reach the bWalletX pairing service'));
    button('Cancel').click();
    await expect(give).resolves.toBe(false);
    expect(m.signal!.aborted).toBe(true);
    expect(document.querySelector('.bwx-ov')).toBeNull();
  });

  it('closes itself once the wallet connects', () => {
    const m = pairingModal({ mode: 'qr' });
    m.onLink(LINK);
    expect(document.querySelector('.bwx-ov')).not.toBeNull();
    m.onPaired!();
    expect(document.querySelector('.bwx-ov')).toBeNull();
  });
});
