/**
 * What BwalletXProvider.connect() does, without React: choose a wallet (no picker when there is no real choice),
 * open it, and sign in with ONE wallet sheet.
 */
import { rememberIdentity, rememberedIdentity } from './account.js';
import { signInAndVerify, type Challenge } from './signin.js';
import { autoChoice, type ConnectedWallet, type WalletOption } from './wallets.js';

export interface ConnectFlowOptions {
  /** The wallets found (discoverWallets). */
  list: WalletOption[];
  /** Connect this option without asking. */
  walletId?: string;
  /** false: never show the picker. Default true. */
  picker?: boolean;
  /** Show the picker; resolves null when closed. */
  pick: (list: WalletOption[]) => Promise<WalletOption | null>;
  /** With verifyUrl: sign in after connecting. */
  challengeUrl?: string;
  verifyUrl?: string;
  challengeNeedsIdentityKey?: boolean;
  /** POST JSON; throws with `status` on a non-2xx answer. */
  post: (url: string, body: unknown) => Promise<Record<string, unknown>>;
}

export interface ConnectFlowResult {
  connected: ConnectedWallet;
  identityKey: string | null;
  handle: string | null;
  paymail: string | null;
  signedIn: boolean;
}

/** Resolves null when the user closed the picker. Throws NOT_FOUND when there is no wallet at all. */
export async function runConnect(o: ConnectFlowOptions): Promise<ConnectFlowResult | null> {
  const { list } = o;
  let choice: WalletOption | null | undefined = o.walletId ? list.find((w) => w.id === o.walletId) : undefined;
  if (!choice) {
    const auto = autoChoice(list, o.picker === false);
    choice = auto === undefined ? await o.pick(list) : auto;
  }
  if (!choice) {
    if (!list.length) throw Object.assign(new Error('No wallet found. Get bWalletX at bwalletx.com.'), { code: 'NOT_FOUND' });
    return null;
  }
  const signIn = !!(o.challengeUrl && o.verifyUrl) && choice.kind !== 'handcash';
  // Signing in: open the wallet WITHOUT asking for the key; the key comes with the signature, in one sheet.
  const cw = await choice.connect(signIn ? { identity: false } : undefined);
  let handle = cw.handle ?? null;
  let paymail = cw.paymail ?? null;
  let identityKey = cw.identityKey;
  let signedIn = false;
  if (cw.wallet && signIn) {
    const { result, verified } = await signInAndVerify({
      wallet: cw.wallet,
      identityKey: cw.identityKey ?? undefined,
      // The key that signed in here last time: a repeat sign-in is then the signature alone.
      identityKeyHint: rememberedIdentity(),
      challengeNeedsIdentityKey: o.challengeNeedsIdentityKey,
      challenge: (key) => o.post(o.challengeUrl!, key ? { identityKey: key } : {}) as unknown as Promise<Challenge>,
      verify: (r) => o.post(o.verifyUrl!, { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature }),
    });
    rememberIdentity(result.identityKey);
    identityKey = result.identityKey;
    handle = (verified.handle as string | undefined) ?? handle;
    paymail = (verified.paymail as string | undefined) ?? paymail;
    signedIn = true;
  } else if (cw.wallet && !identityKey) {
    identityKey = (await cw.wallet.getPublicKey({ identityKey: true })).publicKey;
  }
  return { connected: cw, identityKey, handle, paymail, signedIn };
}
