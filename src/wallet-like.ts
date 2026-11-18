import type { WalletInterface } from '@bsv/sdk';

/**
 * Any BRC-100 wallet you hand to connect: the calls connect makes, and nothing else.
 *
 * connect carries its own @bsv/sdk, so your app may be on another version (1.9, 2.x, 4.x). Their `WalletInterface`
 * types differ in small ways (1.9 types BEEF as number[]; 2.x and later as number[] | Uint8Array), which makes one
 * version's WalletInterface unassignable to another's. Every public parameter that takes a wallet uses this type
 * instead, so a WalletInterface from any @bsv/sdk version fits, and so does a plain object with these methods. Methods
 * (not function properties) on purpose: TypeScript checks method parameters bivariantly.
 *
 * Wallets connect gives back (discovered, paired, or the one you passed) are typed as connect's own WalletInterface.
 */
export interface Brc100Wallet {
  getPublicKey(args: Parameters<WalletInterface['getPublicKey']>[0], originator?: string): Promise<{ publicKey: string }>;
  createSignature(args: Parameters<WalletInterface['createSignature']>[0], originator?: string): Promise<{ signature: number[] | Uint8Array }>;
  createAction(args: Parameters<WalletInterface['createAction']>[0], originator?: string): Promise<{ txid?: string; tx?: number[] | Uint8Array }>;
  listOutputs(
    args: Parameters<WalletInterface['listOutputs']>[0],
    originator?: string,
  ): Promise<{ totalOutputs: number; outputs: { outpoint: string; lockingScript?: string; customInstructions?: string }[] }>;
  isAuthenticated(args: object, originator?: string): Promise<{ authenticated: boolean }>;
  waitForAuthentication(args: object, originator?: string): Promise<{ authenticated: boolean }>;
}

/** The wallet as connect's own WalletInterface type. Runtime: the same object; nothing is wrapped or copied. */
export const asWalletInterface = (w: Brc100Wallet): WalletInterface => w as unknown as WalletInterface;
