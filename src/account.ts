/**
 * The signed-in account as the badge shows it: paymail (best-effort lookup by identity key), a $handle label, a short
 * key when there is no paymail, and the bAvatar picture (gold by default, generated for any key).
 */

export const PAYMAIL_LOOKUP_URL = 'https://pay.bwallet.space/api/paymail/lookup?key=';
export const BAVATAR_URL = 'https://chat.bwalletx.com/api/bavatar/';

/** 0266c1…7c83 */
export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
}

/** $alice for alice@bwalletx.com, a site handle as given, other paymails in full, else a short key. */
export function accountLabel(a: { identityKey?: string | null; paymail?: string | null; handle?: string | null }): string {
  if (a.paymail && /@bwalletx\.com$/i.test(a.paymail)) return '$' + a.paymail.split('@')[0];
  if (a.handle) return a.handle;
  if (a.paymail) return a.paymail;
  return a.identityKey ? shortKey(a.identityKey) : '';
}

/** The bAvatar for an identity key (a generated gold avatar when the user has not set one). */
export function avatarUrlFor(identityKey: string | null | undefined): string | null {
  return identityKey && /^0[23][0-9a-fA-F]{64}$/.test(identityKey) ? `${BAVATAR_URL}${identityKey.toLowerCase()}.png` : null;
}

const cache = new Map<string, Promise<string | null>>();

/** The paymail for an identity key, or null. Best effort: never throws, one request per key per page. */
export function lookupPaymail(identityKey: string, url: string = PAYMAIL_LOOKUP_URL): Promise<string | null> {
  if (url === 'off' || typeof fetch === 'undefined') return Promise.resolve(null);
  const k = `${url}|${identityKey}`;
  let p = cache.get(k);
  if (!p) {
    p = fetch(url + encodeURIComponent(identityKey))
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { paymail?: unknown } | null) => (j && typeof j.paymail === 'string' ? j.paymail : null))
      .catch(() => null);
    cache.set(k, p);
  }
  return p;
}

/** True when the user said no in the wallet (BRC-100 denial, or a picker / sheet closed). */
export function isUserRejection(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ERR_PERMISSION_DENIED' || code === 4001) return true;
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /denied|reject|cancel|declin|refused|not now|user closed/i.test(msg);
}

/** One plain line for an error: "Sign-in cancelled" for a no in the wallet, otherwise the gist. */
export function signInErrorText(e: unknown): string {
  if (isUserRejection(e)) return 'Sign-in cancelled';
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'NOT_FOUND') return 'bWalletX was not found in this browser';
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (/lock/i.test(msg)) return 'Your wallet is locked. Unlock it and try again';
  if (/timeout|timed out|expired/i.test(msg)) return 'The wallet did not answer in time';
  if (/origin/i.test(msg)) return 'This page is not on the site’s configured origin';
  return 'Sign-in failed';
}

/** Copy text to the clipboard; true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** localStorage key for the identity key that last signed in on this site (public data; a hint, never trusted). */
export const IDENTITY_HINT_KEY = 'bwx:identityKey';

/**
 * The identity key that last signed in on this site, if any. Passing it to signInWithBwalletX makes a repeat sign-in
 * ONE wallet call (createSignature only). It is only a hint: the server still checks the signature against it, and a
 * wrong hint (another account) fails verification and is retried with the key asked for.
 */
export function rememberedIdentity(): string | undefined {
  try {
    const k = globalThis.localStorage?.getItem(IDENTITY_HINT_KEY) ?? '';
    return /^0[23][0-9a-f]{64}$/i.test(k) ? k : undefined;
  } catch {
    return undefined;
  }
}

export function rememberIdentity(key: string | null): void {
  try {
    if (key) globalThis.localStorage?.setItem(IDENTITY_HINT_KEY, key);
    else globalThis.localStorage?.removeItem(IDENTITY_HINT_KEY);
  } catch {
    /* storage blocked */
  }
}
