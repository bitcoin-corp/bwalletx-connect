/**
 * Server side: check that a transaction really pays what you expected before you deliver anything.
 * Read-only: it never broadcasts, signs or retries a spend.
 */
import { P2PKH, Transaction, Utils, type ChainTracker } from '@bsv/sdk';

export interface ExpectedOutput {
  /** Locking script hex. Give this or `address`. */
  script?: string;
  /** A P2PKH address. */
  address?: string;
  /** Minimum satoshis this output must carry. */
  satoshis: number;
}

export type TxStatus =
  | { state: 'confirmed'; confirmations: number; source: 'woc' | 'arc' }
  | { state: 'mempool'; source: 'woc' | 'arc'; detail?: string }
  | { state: 'not-found' | 'rejected'; source: 'woc' | 'arc'; detail?: string }
  | { state: 'unchecked' };

export interface VerifyPaymentOptions {
  /** A txid (fetched from WhatsOnChain), raw tx / BEEF / Atomic BEEF as hex, or BEEF bytes. */
  tx: string | number[] | Uint8Array;
  /** Every one must be matched by a different output. */
  expected: ExpectedOutput[];
  network?: 'main' | 'test';
  /** Where to ask for status. Default 'woc'. 'none' skips the network (BEEF only). */
  status?: 'woc' | 'arc' | 'none';
  /** ARC base URL, e.g. https://arc.taal.com. Needed when status is 'arc'. */
  arcUrl?: string;
  /** Sent as Bearer. Read it from env; never hardcode. */
  arcApiKey?: string;
  /** Fail unless the network has seen the tx (mempool or confirmed). Default false. */
  requireSeen?: boolean;
  /** Minimum confirmations. Default 0. */
  minConfirmations?: number;
  /** Also run SPV (merkle proofs + scripts) on a BEEF with this chain tracker. */
  spv?: ChainTracker;
  /** Injected fetch (tests, custom agents). Default globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface VerifyPaymentResult {
  ok: true;
  txid: string;
  /** For each expected output, the index of the output that paid it. */
  matched: { vout: number; satoshis: number; script: string }[];
  status: TxStatus;
}

export type PaymentErrorCode = 'BAD_TX' | 'TX_NOT_FOUND' | 'OUTPUT_MISSING' | 'NOT_SEEN' | 'REJECTED' | 'SPV_FAILED' | 'NETWORK' | 'BAD_EXPECTED';

export class PaymentVerificationError extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    message: string,
    readonly txid?: string,
  ) {
    super(message);
    this.name = 'PaymentVerificationError';
  }
}

const isHex = (s: string) => /^([0-9a-fA-F]{2})+$/.test(s);
const woc = (n: 'main' | 'test') => `https://api.whatsonchain.com/v1/bsv/${n}`;

function parseTx(input: string | number[] | Uint8Array): Transaction {
  const bytes = typeof input === 'string' ? Utils.toArray(input, 'hex') : Array.from(input);
  const tries: (() => Transaction)[] = [
    () => Transaction.fromAtomicBEEF(bytes),
    () => Transaction.fromBEEF(bytes),
    () => Transaction.fromBinary(bytes),
  ];
  for (const t of tries) {
    try {
      return t();
    } catch {
      /* next format */
    }
  }
  throw new PaymentVerificationError('BAD_TX', 'Could not parse the transaction (expected a txid, raw tx, BEEF or Atomic BEEF).');
}

function expectedScript(e: ExpectedOutput): string {
  if (!Number.isSafeInteger(e.satoshis) || e.satoshis < 0) throw new PaymentVerificationError('BAD_EXPECTED', 'expected.satoshis must be a non-negative integer');
  if (e.script) {
    if (!isHex(e.script)) throw new PaymentVerificationError('BAD_EXPECTED', 'expected.script must be hex');
    return e.script.toLowerCase();
  }
  if (e.address) {
    try {
      return new P2PKH().lock(e.address).toHex();
    } catch {
      throw new PaymentVerificationError('BAD_EXPECTED', `Not a valid address: ${e.address}`);
    }
  }
  throw new PaymentVerificationError('BAD_EXPECTED', 'Each expected output needs a script or an address');
}

async function getJson(f: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  let r: Response;
  try {
    r = await f(url, { headers });
  } catch (e) {
    throw new PaymentVerificationError('NETWORK', `Could not reach ${new URL(url).host}: ${(e as Error).message}`);
  }
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: r.status, body };
}

async function checkStatus(o: VerifyPaymentOptions, f: typeof fetch, txid: string): Promise<TxStatus> {
  const mode = o.status ?? 'woc';
  if (mode === 'none') return { state: 'unchecked' };
  if (mode === 'arc') {
    if (!o.arcUrl) throw new PaymentVerificationError('NETWORK', "status 'arc' needs arcUrl");
    const { status, body } = await getJson(f, `${o.arcUrl.replace(/\/$/, '')}/v1/tx/${txid}`, o.arcApiKey ? { Authorization: `Bearer ${o.arcApiKey}` } : {});
    if (status === 404) return { state: 'not-found', source: 'arc' };
    if (status >= 400) throw new PaymentVerificationError('NETWORK', `ARC answered ${status}`, txid);
    const b = body as { txStatus?: string; blockHeight?: number; extraInfo?: string };
    const s = String(b.txStatus ?? '').toUpperCase();
    if (s === 'MINED' || s === 'IMMUTABLE') return { state: 'confirmed', confirmations: 1, source: 'arc' };
    if (s === 'REJECTED' || s === 'DOUBLE_SPEND_ATTEMPTED') return { state: 'rejected', source: 'arc', detail: b.extraInfo ?? s };
    if (s === 'UNKNOWN' || s === '') return { state: 'not-found', source: 'arc', detail: s };
    return { state: 'mempool', source: 'arc', detail: s };
  }
  const { status, body } = await getJson(f, `${woc(o.network ?? 'main')}/tx/hash/${txid}`);
  if (status === 404) return { state: 'not-found', source: 'woc' };
  if (status >= 400) throw new PaymentVerificationError('NETWORK', `WhatsOnChain answered ${status}`, txid);
  const c = Number((body as { confirmations?: number }).confirmations ?? 0);
  return c > 0 ? { state: 'confirmed', confirmations: c, source: 'woc' } : { state: 'mempool', source: 'woc' };
}

/**
 * Throws PaymentVerificationError (with a `code`) unless every expected output is paid by a
 * distinct output of the transaction with at least the expected satoshis.
 */
export async function verifyPayment(o: VerifyPaymentOptions): Promise<VerifyPaymentResult> {
  const f = o.fetch ?? globalThis.fetch;
  if (!o.expected?.length) throw new PaymentVerificationError('BAD_EXPECTED', 'Pass at least one expected output');
  const want = o.expected.map((e) => ({ script: expectedScript(e), satoshis: e.satoshis }));

  let tx: Transaction;
  if (typeof o.tx === 'string' && /^[0-9a-fA-F]{64}$/.test(o.tx)) {
    const txid = o.tx.toLowerCase();
    let r: Response;
    try {
      r = await f(`${woc(o.network ?? 'main')}/tx/${txid}/hex`);
    } catch (e) {
      throw new PaymentVerificationError('NETWORK', `Could not reach WhatsOnChain: ${(e as Error).message}`, txid);
    }
    if (r.status === 404) throw new PaymentVerificationError('TX_NOT_FOUND', `Transaction ${txid} was not found`, txid);
    if (!r.ok) throw new PaymentVerificationError('NETWORK', `WhatsOnChain answered ${r.status}`, txid);
    tx = parseTx((await r.text()).trim());
    if (tx.id('hex') !== txid) throw new PaymentVerificationError('BAD_TX', 'The fetched transaction does not match the txid', txid);
  } else {
    if (typeof o.tx === 'string' && !isHex(o.tx)) throw new PaymentVerificationError('BAD_TX', 'tx must be a txid or hex');
    tx = parseTx(o.tx);
  }
  const txid = tx.id('hex');

  if (o.spv) {
    let ok = false;
    try {
      ok = await tx.verify(o.spv);
    } catch (e) {
      throw new PaymentVerificationError('SPV_FAILED', `SPV check failed: ${(e as Error).message}`, txid);
    }
    if (!ok) throw new PaymentVerificationError('SPV_FAILED', 'SPV check failed', txid);
  }

  const used = new Set<number>();
  const matched: VerifyPaymentResult['matched'] = [];
  for (const w of want) {
    const vout = tx.outputs.findIndex(
      (out, i) => !used.has(i) && out.lockingScript.toHex() === w.script && (out.satoshis ?? 0) >= w.satoshis,
    );
    if (vout < 0) {
      throw new PaymentVerificationError('OUTPUT_MISSING', `No output pays ${w.satoshis} sats to script ${w.script.slice(0, 16)}…`, txid);
    }
    used.add(vout);
    matched.push({ vout, satoshis: tx.outputs[vout].satoshis ?? 0, script: w.script });
  }

  const status = await checkStatus(o, f, txid);
  if (status.state === 'rejected') throw new PaymentVerificationError('REJECTED', `The network rejected ${txid}: ${status.detail ?? ''}`.trim(), txid);
  if ((o.requireSeen || (o.minConfirmations ?? 0) > 0) && status.state !== 'mempool' && status.state !== 'confirmed') {
    throw new PaymentVerificationError('NOT_SEEN', `The network has not seen ${txid} yet`, txid);
  }
  const conf = status.state === 'confirmed' ? status.confirmations : 0;
  if ((o.minConfirmations ?? 0) > conf) {
    throw new PaymentVerificationError('NOT_SEEN', `${txid} has ${conf} confirmations, needs ${o.minConfirmations}`, txid);
  }
  return { ok: true, txid, matched, status };
}
