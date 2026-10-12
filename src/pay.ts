/**
 * Browser-side payment helpers on top of the BRC-100 wallet's createAction. Works with any
 * BRC-100 wallet. Each helper asks the wallet once; it never retries a spend. If a call fails
 * the error says whether the wallet may have sent anything (`maybeSent`).
 */
import { P2PKH, PublicKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';

/** BRC-29 payment protocol id. */
export const BRC29_PROTOCOL: [2, string] = [2, '3241645161d8'];

export type PayTo = string; // paymail (name@domain), P2PKH address, or 66-hex identity key

export interface PayOutput {
  /** Locking script hex. */
  script: string;
  satoshis: number;
  description?: string;
}

export interface PayRequest {
  to: PayTo;
  /** Amount in satoshis. Give this or `usd`. */
  sats?: number;
  /** Amount in US dollars, converted at `usdPerBsv` (or the live WhatsOnChain rate). */
  usd?: number;
  /** Shown in the wallet and, with `memoOnChain`, written in an OP_RETURN output. */
  memo?: string;
  memoOnChain?: boolean;
  /** Labels for the wallet's history. */
  labels?: string[];
}

export interface PayOptions {
  /** Fixed rate for `usd`. Otherwise fetched from WhatsOnChain. */
  usdPerBsv?: number | (() => Promise<number>);
  /** Resolve a paymail to outputs. Default: bsvalias P2P payment destination (needs CORS on the paymail host). */
  resolvePaymail?: (paymail: string, sats: number) => Promise<{ outputs: PayOutput[]; reference?: string; submit?: (rawTxHex: string) => Promise<void> }>;
  fetch?: typeof fetch;
}

export interface Brc29Remittance {
  senderIdentityKey: string;
  derivationPrefix: string;
  derivationSuffix: string;
  outputIndex: number;
}

export interface PayResult {
  txid: string;
  /** Atomic BEEF (BRC-95) if the wallet returned it. Send it to your server's verifyPayment. */
  tx?: number[];
  sats: number;
  outputs: PayOutput[];
  /** For an identity-key payment: what the recipient needs to internalize the output (BRC-29). Deliver it to them. */
  remittance?: Brc29Remittance;
}

export type PaymentErrorCode = 'BAD_REQUEST' | 'RESOLVE_FAILED' | 'RATE_FAILED' | 'WALLET_REJECTED' | 'WALLET_ERROR' | 'NOT_SUPPORTED';

export class PaymentError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    /** true when the wallet was asked to spend and the outcome is unknown. Check before trying again. */
    readonly maybeSent = false,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/** A wallet that is not BRC-100 (the HandCash transitional adapter) can still pay through this. */
export interface LegacyPayer {
  pay(req: PayRequest & { sats: number }): Promise<PayResult>;
}
export type PaySource = WalletInterface | LegacyPayer;

const isLegacy = (s: PaySource): s is LegacyPayer => typeof (s as LegacyPayer).pay === 'function' && typeof (s as WalletInterface).createAction !== 'function';

export const isIdentityKeyHex = (s: string) => /^0[23][0-9a-fA-F]{64}$/.test(s);
export const isPaymail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function randomB64(n: number) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return Utils.toBase64(Array.from(b));
}

function opReturn(text: string): string {
  const d = Utils.toArray(text, 'utf8');
  const len = d.length;
  const push = len < 0x4c ? [len] : len <= 0xff ? [0x4c, len] : [0x4d, len & 0xff, len >> 8];
  return Utils.toHex([0x00, 0x6a, ...push, ...d]);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** createAction descriptions must be 5–50 bytes. */
const describe = (s: string) => clip(s.length < 5 ? `${s} payment`.trim() : s, 50);

async function usdRate(o: PayOptions): Promise<number> {
  if (typeof o.usdPerBsv === 'number') return o.usdPerBsv;
  try {
    if (typeof o.usdPerBsv === 'function') return await o.usdPerBsv();
    const r = await (o.fetch ?? fetch)('https://api.whatsonchain.com/v1/bsv/main/exchangerate');
    const j = (await r.json()) as { rate?: number };
    if (!r.ok || !(Number(j.rate) > 0)) throw new Error(`status ${r.status}`);
    return Number(j.rate);
  } catch (e) {
    throw new PaymentError('RATE_FAILED', `Could not get the BSV/USD rate: ${(e as Error).message}`, false, e);
  }
}

/** Satoshis for a request (sats as given, or usd converted, rounded up). */
export async function amountInSats(req: Pick<PayRequest, 'sats' | 'usd'>, o: PayOptions = {}): Promise<number> {
  if (req.sats != null) {
    if (!Number.isSafeInteger(req.sats) || req.sats <= 0) throw new PaymentError('BAD_REQUEST', 'sats must be a positive integer');
    return req.sats;
  }
  if (req.usd != null) {
    if (!(req.usd > 0)) throw new PaymentError('BAD_REQUEST', 'usd must be positive');
    return Math.max(1, Math.ceil((req.usd / (await usdRate(o))) * 1e8));
  }
  throw new PaymentError('BAD_REQUEST', 'Give sats or usd');
}

/** Default paymail resolver: bsvalias P2P Payment Destination (BRC-? / capability 2a40af698840). */
export async function resolvePaymailP2P(paymail: string, sats: number, f: typeof fetch = fetch) {
  const [alias, domain] = paymail.split('@');
  const fail = (m: string, e?: unknown) => new PaymentError('RESOLVE_FAILED', `Could not resolve ${paymail}: ${m}`, false, e);
  let caps: Record<string, string>;
  try {
    const r = await f(`https://${domain}/.well-known/bsvalias`);
    caps = ((await r.json()) as { capabilities: Record<string, string> }).capabilities;
  } catch (e) {
    throw fail('no bsvalias document (or CORS blocked it; resolve on your server and pass resolvePaymail)', e);
  }
  const fill = (u: string) => u.replace('{alias}', encodeURIComponent(alias)).replace('{domain.tld}', domain);
  const dest = caps?.['2a40af698840'];
  if (!dest) throw fail('it does not offer P2P payment destinations');
  let body: { outputs?: { script: string; satoshis: number }[]; reference?: string };
  try {
    const r = await f(fill(dest), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ satoshis: sats }) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    body = await r.json();
  } catch (e) {
    throw fail((e as Error).message, e);
  }
  if (!body.outputs?.length) throw fail('no outputs returned');
  const receive = caps['5f1323cddf31'];
  return {
    outputs: body.outputs.map((o) => ({ script: o.script, satoshis: o.satoshis })),
    reference: body.reference,
    submit: receive
      ? async (hex: string) => {
          await f(fill(receive), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hex, reference: body.reference, metadata: {} }),
          });
        }
      : undefined,
  };
}

async function runAction(wallet: WalletInterface, description: string, outputs: PayOutput[], labels?: string[]) {
  try {
    return await wallet.createAction({
      description: describe(description),
      outputs: outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis, outputDescription: describe(o.description ?? 'payment') })),
      labels: labels?.length ? labels : undefined,
      options: { randomizeOutputs: false },
    });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const rejected = /denied|reject|cancel|abort|user/i.test(msg) || (e as { code?: unknown })?.code === 4001;
    // Not retried: a lost reply could mean the wallet already broadcast it.
    throw new PaymentError(rejected ? 'WALLET_REJECTED' : 'WALLET_ERROR', rejected ? 'The payment was declined in the wallet.' : `The wallet could not make the payment: ${msg}`, !rejected, e);
  }
}

/** Pay a paymail, address or identity key. One wallet prompt; never retried. */
export async function pay(source: PaySource, req: PayRequest, o: PayOptions = {}): Promise<PayResult> {
  const to = (req.to ?? '').trim();
  if (!to) throw new PaymentError('BAD_REQUEST', 'Give a recipient (to)');
  if (req.memo && req.memo.length > 1000) throw new PaymentError('BAD_REQUEST', 'memo is too long');
  const sats = await amountInSats(req, o);
  if (isLegacy(source)) return source.pay({ ...req, to, sats });

  let outputs: PayOutput[];
  let remittance: Brc29Remittance | undefined;
  let submit: ((hex: string) => Promise<void>) | undefined;
  if (isIdentityKeyHex(to)) {
    const derivationPrefix = randomB64(8);
    const derivationSuffix = randomB64(8);
    let pk: string;
    let me: string;
    try {
      ({ publicKey: pk } = await source.getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: to.toLowerCase() }));
      ({ publicKey: me } = await source.getPublicKey({ identityKey: true }));
    } catch (e) {
      throw new PaymentError('WALLET_ERROR', `The wallet could not derive the payment key: ${(e as Error).message}`, false, e);
    }
    outputs = [{ script: new P2PKH().lock(PublicKey.fromString(pk).toHash() as number[]).toHex(), satoshis: sats, description: 'payment' }];
    remittance = { senderIdentityKey: me, derivationPrefix, derivationSuffix, outputIndex: 0 };
  } else if (isPaymail(to)) {
    const r = await (o.resolvePaymail ?? ((p, s) => resolvePaymailP2P(p, s, o.fetch ?? fetch)))(to, sats);
    outputs = r.outputs;
    submit = r.submit;
  } else {
    try {
      outputs = [{ script: new P2PKH().lock(to).toHex(), satoshis: sats, description: 'payment' }];
    } catch {
      throw new PaymentError('BAD_REQUEST', `Not a paymail, address or identity key: ${to}`);
    }
  }
  if (req.memo && req.memoOnChain) outputs = [...outputs, { script: opReturn(req.memo), satoshis: 0, description: 'memo' }];

  const r = await runAction(source, req.memo || `Pay ${clip(to, 30)}`, outputs, req.labels);
  if (!r.txid) throw new PaymentError('WALLET_ERROR', 'The wallet did not return a txid', true);
  const tx = r.tx ? Array.from(r.tx) : undefined;
  if (submit && tx) {
    // Tell the paymail host about the tx. Best effort: the payment itself is already made.
    await submit(Transaction.fromAtomicBEEF(tx).toHex()).catch(() => {});
  }
  return { txid: r.txid, tx, sats, outputs, remittance };
}

/** pay() labelled as a tip. */
export function tip(source: PaySource, req: PayRequest, o: PayOptions = {}): Promise<PayResult> {
  return pay(source, { memo: 'Tip', ...req, labels: [...(req.labels ?? []), 'tip'] }, o);
}

export interface TokenQuote {
  /** Outputs to fund, as your server priced them (e.g. payment to the seller + fee). */
  outputs: PayOutput[];
  description?: string;
  /** Called with the result after the wallet signs; e.g. POST txid + tx to your server for verifyPayment. */
  onPaid?: (r: PayResult) => Promise<void> | void;
}

export interface BuyTokenRequest {
  token: string;
  amount: number | string;
  /** The hook point: return the outputs for this purchase (usually from your server). */
  quote: (req: { token: string; amount: number | string }) => Promise<TokenQuote>;
  labels?: string[];
}

/** Buy a token: your `quote` hook prices it, the wallet pays once, `onPaid` delivers it. */
export async function buyToken(source: PaySource, req: BuyTokenRequest): Promise<PayResult> {
  if (isLegacy(source)) throw new PaymentError('NOT_SUPPORTED', 'This wallet cannot buy tokens. Use a BRC-100 wallet such as bWalletX.');
  const q = await req.quote({ token: req.token, amount: req.amount });
  if (!q?.outputs?.length) throw new PaymentError('BAD_REQUEST', 'The quote returned no outputs');
  const sats = q.outputs.reduce((n, x) => n + x.satoshis, 0);
  const r = await runAction(source, q.description ?? `Buy ${clip(req.token, 30)}`, q.outputs, [...(req.labels ?? []), 'token-buy']);
  if (!r.txid) throw new PaymentError('WALLET_ERROR', 'The wallet did not return a txid', true);
  const res: PayResult = { txid: r.txid, tx: r.tx ? Array.from(r.tx) : undefined, sats, outputs: q.outputs };
  await q.onPaid?.(res);
  return res;
}
