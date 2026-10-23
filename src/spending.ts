/**
 * Streaming spending grants (bWalletX): one approval lets a site stream small payments while the user watches,
 * up to a cap per rolling hour. bWalletX takes the site's origin from the browser, never from this call.
 *
 * Later createAction calls are approved without a sheet when they come from the same site, carry the protocol
 * name in `labels` (or `options.spendingAuthorization: { protocolID }`), and fit in the hour's budget before
 * expiry. Everything else still asks the user.
 */
import type { WalletInterface } from '@bsv/sdk';

export const STREAM_PROTOCOL: [2, string] = [2, 'bmovies stream'];

export interface SpendingAuthorizationRequest {
  protocolID: [2, string];
  /** Most the site may spend in any rolling hour, in satoshis. The user may lower it. */
  capSatsPerHour: number;
  /** Unix seconds. The wallet caps grants at 24 hours; default 4 hours. */
  expiry?: number;
  description?: string;
}

export interface SpendingAuthorizationGrant {
  grantId: string;
  protocolID: [2, string];
  /** What the user approved (at most what was asked). */
  capSatsPerHour: number;
  /** Unix seconds. */
  expiry: number;
}

export type SpendingAuthorizationErrorCode = 'NOT_SUPPORTED' | 'DECLINED' | 'WALLET_ERROR';

export class SpendingAuthorizationError extends Error {
  constructor(
    readonly code: SpendingAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SpendingAuthorizationError';
  }
}

interface SpendingCapable {
  spendingAuthorizationVersion?: number;
  requestSpendingAuthorization(args: SpendingAuthorizationRequest): Promise<{ granted: boolean } & Partial<SpendingAuthorizationGrant>>;
  revokeSpendingAuthorization(grantId: string): Promise<unknown>;
}

type MaybeWallet = WalletInterface | Partial<SpendingCapable> | null | undefined;

const pageWallet = (): MaybeWallet =>
  typeof window !== 'undefined' ? ((window as unknown as { CWI?: MaybeWallet }).CWI ?? undefined) : undefined;

const capable = (w: MaybeWallet): w is SpendingCapable =>
  !!w &&
  typeof (w as Partial<SpendingCapable>).requestSpendingAuthorization === 'function' &&
  typeof (w as Partial<SpendingCapable>).revokeSpendingAuthorization === 'function';

/** True when the wallet (default: window.CWI) supports streaming spending grants. */
export const supportsSpendingAuthorization = (wallet: MaybeWallet = pageWallet()): boolean => capable(wallet);

/** Ask once. Resolves with the grant, or rejects with SpendingAuthorizationError (DECLINED, NOT_SUPPORTED, WALLET_ERROR). */
export const requestSpendingAuthorization = async (
  req: SpendingAuthorizationRequest,
  wallet: MaybeWallet = pageWallet(),
): Promise<SpendingAuthorizationGrant> => {
  if (!capable(wallet)) throw new SpendingAuthorizationError('NOT_SUPPORTED', 'This wallet does not support streaming payments');
  if (!Array.isArray(req.protocolID) || req.protocolID[0] !== 2 || typeof req.protocolID[1] !== 'string')
    throw new SpendingAuthorizationError('WALLET_ERROR', 'protocolID must be [2, "<protocol name>"]');
  if (!(req.capSatsPerHour >= 1)) throw new SpendingAuthorizationError('WALLET_ERROR', 'capSatsPerHour must be at least 1');
  let r: { granted: boolean } & Partial<SpendingAuthorizationGrant>;
  try {
    r = await wallet.requestSpendingAuthorization({
      protocolID: req.protocolID,
      capSatsPerHour: req.capSatsPerHour,
      expiry: req.expiry,
      description: req.description,
    });
  } catch (e) {
    throw new SpendingAuthorizationError('WALLET_ERROR', e instanceof Error ? e.message : String(e));
  }
  if (!r?.granted || typeof r.grantId !== 'string') throw new SpendingAuthorizationError('DECLINED', 'Declined');
  return {
    grantId: r.grantId,
    protocolID: (r.protocolID as [2, string]) ?? req.protocolID,
    capSatsPerHour: r.capSatsPerHour ?? req.capSatsPerHour,
    expiry: r.expiry ?? req.expiry ?? 0,
  };
};

/** End a grant early (e.g. when the viewer stops watching). */
export const revokeSpendingAuthorization = async (grantId: string, wallet: MaybeWallet = pageWallet()): Promise<void> => {
  if (!capable(wallet)) throw new SpendingAuthorizationError('NOT_SUPPORTED', 'This wallet does not support streaming payments');
  try {
    await wallet.revokeSpendingAuthorization(grantId);
  } catch (e) {
    throw new SpendingAuthorizationError('WALLET_ERROR', e instanceof Error ? e.message : String(e));
  }
};
