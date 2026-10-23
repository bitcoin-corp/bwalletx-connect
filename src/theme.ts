/**
 * Site theme for the wallet. A site may ask bWalletX to wear one of the themes the wallet already bundles
 * (e.g. 'npgx') while the site is connected and is the active tab; the wallet puts the user's own theme back on
 * any other site or when this declaration is removed. Only an id is declared: the wallet decides whether this
 * origin may wear it (brand editions are locked to their own sites) and never loads colours, CSS or URLs from here.
 */
export const WALLET_THEME_META = 'bwalletx-theme';

const ID = /^[a-z0-9-]{1,32}$/;

/** Declare (or with null, withdraw) the theme the wallet should wear for this page. No-op outside a browser. */
export function declareWalletTheme(theme: string | null | undefined): void {
  if (typeof document === 'undefined') return;
  const id = (theme ?? '').trim().toLowerCase();
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${WALLET_THEME_META}"]`);
  if (!id || !ID.test(id)) {
    meta?.remove();
    return;
  }
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = WALLET_THEME_META;
    document.head.appendChild(meta);
  }
  if (meta.content !== id) meta.content = id;
}
