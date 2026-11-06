/** Device checks shared by the modal and the Metanet Desktop option (no DOM created here). */
/**
 * True on a phone or tablet: a coarse pointer with no hover, or a mobile user agent (iPadOS reports
 * a Mac UA, so touch points count too). Scanning a QR shown on the same screen is impossible there.
 */
export function isTouchDevice(env: { navigator?: Navigator; matchMedia?: (q: string) => MediaQueryList } = globalThis as never): boolean {
  const nav = env.navigator;
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return true;
  try {
    return !!env.matchMedia?.('(pointer: coarse)').matches && !env.matchMedia?.('(hover: hover)').matches;
  } catch {
    return false;
  }
}
