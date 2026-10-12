/**
 * React wrapper for <bwalletx-signin>. React is an optional peer dependency; the button itself is
 * the web component, so markup and behaviour are identical everywhere.
 *
 *   import { BwalletxSignin } from '@bwalletx/connect/react';
 *   <BwalletxSignin challengeUrl="/auth/bwalletx/challenge" verifyUrl="/auth/bwalletx/verify"
 *     onSignedIn={(d) => router.refresh()} />
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { WalletInterface } from '@bsv/sdk';
import { clearPairing } from './pair.js';
import { signInWithBwalletX, type Challenge } from './signin.js';
import { pairingModal } from './modal.js';
import { pickWallet } from './modal.js';
import { discoverWallets, type ConnectedWallet, type WalletOption } from './wallets.js';
import { PaymentError, buyToken, pay, tip, type BuyTokenRequest, type PayOptions, type PayRequest, type PayResult } from './pay.js';
import { defineBwalletxSignin, type SigninBrand, type SigninLabel, type SigninSize, type SigninTheme } from './element.js';

export interface SignedInDetail {
  identityKey: string;
  method: string;
  nonce: string;
  signature: number[];
  response: unknown;
}

export interface BwalletxSigninProps {
  size?: SigninSize;
  theme?: SigninTheme;
  label?: SigninLabel;
  brand?: SigninBrand;
  /** true/undefined = default, false = hidden, string = custom text. */
  subtitle?: boolean | string;
  fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  challengeUrl?: string;
  verifyUrl?: string;
  getUrl?: string;
  webUrl?: string;
  href?: string;
  authorizeUrl?: string;
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  discoverMs?: number;
  'aria-label'?: string;
  className?: string;
  style?: CSSProperties;
  id?: string;
  /** Every click. Call e.preventDefault() to skip the built-in flow. */
  onClick?: (e: CustomEvent<{ element: HTMLElement }>) => void;
  onSignedIn?: (d: SignedInDetail) => void;
  onNotFound?: () => void;
  onError?: (error: unknown) => void;
}

export function BwalletxSignin(props: BwalletxSigninProps): ReactElement {
  const ref = useRef<HTMLElement>(null);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    defineBwalletxSignin();
    const el = ref.current;
    if (!el) return;
    const on: [string, EventListener][] = [
      ['bwalletx-signin', (e) => cb.current.onClick?.(e as CustomEvent<{ element: HTMLElement }>)],
      ['bwalletx-signed-in', (e) => cb.current.onSignedIn?.((e as CustomEvent<SignedInDetail>).detail)],
      ['bwalletx-not-found', () => cb.current.onNotFound?.()],
      ['bwalletx-error', (e) => cb.current.onError?.((e as CustomEvent<{ error: unknown }>).detail.error)],
    ];
    for (const [t, f] of on) el.addEventListener(t, f);
    return () => { for (const [t, f] of on) el.removeEventListener(t, f); };
  }, []);

  const p = props;
  const flag = (v: boolean | undefined) => (v ? '' : undefined);
  return createElement('bwalletx-signin', {
    ref,
    id: p.id,
    class: p.className,
    style: p.style,
    size: p.size,
    theme: p.theme,
    label: p.label,
    brand: p.brand,
    subtitle: p.subtitle === false ? 'off' : typeof p.subtitle === 'string' ? p.subtitle : undefined,
    'full-width': flag(p.fullWidth),
    loading: flag(p.loading),
    disabled: flag(p.disabled),
    'challenge-url': p.challengeUrl,
    'verify-url': p.verifyUrl,
    'get-url': p.getUrl,
    'web-url': p.webUrl,
    href: p.href,
    'authorize-url': p.authorizeUrl,
    'client-id': p.clientId,
    'redirect-uri': p.redirectUri,
    scope: p.scope,
    'discover-ms': p.discoverMs,
    'aria-label': p['aria-label'],
  });
}

export default BwalletxSignin;

export type BwalletXStatus = 'idle' | 'restoring' | 'connecting' | 'connected' | 'error';

export interface BwalletXState {
  status: BwalletXStatus;
  identityKey: string | null;
  handle: string | null;
  paymail: string | null;
  /** The BRC-100 wallet. null until connect() (a session restored from the cookie has no wallet yet). */
  wallet: WalletInterface | null;
  /** Which option connected (e.g. 'com.bwalletx.extension', 'bwalletx-pairing', 'handcash'). */
  walletId: string | null;
  /** True while the transitional HandCash adapter is in use. */
  transitional: boolean;
  /** The server session (verifyUrl/sessionUrl) is in place. */
  signedIn: boolean;
  error: Error | null;
}

export interface BwalletXContextValue extends BwalletXState {
  /** Find wallets, show the picker if there is a choice, connect, and sign in if verifyUrl is set. */
  connect(opts?: { walletId?: string }): Promise<ConnectedWallet | null>;
  disconnect(): Promise<void>;
  /** The wallets found on the last connect() (or listWallets()). */
  wallets: WalletOption[];
  listWallets(): Promise<WalletOption[]>;
  pay(req: PayRequest): Promise<PayResult>;
  tip(req: PayRequest): Promise<PayResult>;
  buyToken(req: BuyTokenRequest): Promise<PayResult>;
}

export interface BwalletXProviderProps {
  children?: ReactNode;
  /** POST { identityKey } → challenge. With verifyUrl, connect() also signs in. */
  challengeUrl?: string;
  /** POST { identityKey, nonce, signature } → { identityKey, handle?, paymail? } and sets the cookie. */
  verifyUrl?: string;
  /** POST to clear the cookie on disconnect(). */
  logoutUrl?: string;
  /** GET → { identityKey, handle?, paymail? } to restore a session on load. */
  sessionUrl?: string;
  /** Offer phone pairing with the built-in QR modal. Default true. */
  pairing?: boolean;
  /** Show the built-in picker when more than one wallet is available. Default true. */
  picker?: boolean;
  /** Extra options, e.g. [handcashAdapter({ login })]. */
  extraWallets?: WalletOption[];
  /** Probe desktop wallets on localhost. Default false. */
  probeLocal?: boolean;
  discoverMs?: number;
  payOptions?: PayOptions;
  onError?: (e: Error) => void;
}

const empty: BwalletXState = {
  status: 'idle', identityKey: null, handle: null, paymail: null, wallet: null, walletId: null, transitional: false, signedIn: false, error: null,
};

const Ctx = createContext<BwalletXContextValue | null>(null);

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw Object.assign(new Error(String(j.error ?? `${url} answered ${r.status}`)), { status: r.status, code: j.code });
  return j;
}

/** Holds the connected wallet and session for the tree. Renders nothing itself; SSR-safe. */
export function BwalletXProvider(p: BwalletXProviderProps): ReactElement {
  const [state, setState] = useState<BwalletXState>(empty);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const props = useRef(p);
  props.current = p;
  const payer = useRef<ConnectedWallet['payer']>(null);

  const fail = useCallback((e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    setState((s) => ({ ...s, status: 'error', error: err }));
    props.current.onError?.(err);
    return err;
  }, []);

  useEffect(() => {
    const url = p.sessionUrl;
    if (!url) return;
    let live = true;
    setState((s) => ({ ...s, status: 'restoring' }));
    fetch(url, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j: { identityKey?: string | null; handle?: string; paymail?: string }) => {
        if (!live) return;
        setState((s) =>
          j.identityKey
            ? { ...s, status: 'connected', identityKey: j.identityKey, handle: j.handle ?? null, paymail: j.paymail ?? null, signedIn: true }
            : { ...s, status: s.status === 'restoring' ? 'idle' : s.status },
        );
      })
      .catch(() => live && setState((s) => ({ ...s, status: s.status === 'restoring' ? 'idle' : s.status })));
    return () => {
      live = false;
    };
  }, [p.sessionUrl]);

  const listWallets = useCallback(async () => {
    const c = props.current;
    const list = await discoverWallets({
      ms: c.discoverMs,
      probeLocal: c.probeLocal,
      extra: c.extraWallets,
      pairing: c.pairing === false ? undefined : () => pairingModal(),
    });
    setWallets(list);
    return list;
  }, []);

  const connect = useCallback(
    async (opts: { walletId?: string } = {}) => {
      const c = props.current;
      setState((s) => ({ ...s, status: 'connecting', error: null }));
      try {
        const list = await listWallets();
        let choice: WalletOption | null | undefined = opts.walletId ? list.find((w) => w.id === opts.walletId) : undefined;
        if (!choice) {
          const direct = list.filter((w) => w.kind !== 'pairing');
          choice = c.picker !== false && list.length > 1 ? await pickWallet(list) : (direct[0] ?? list[0] ?? null);
        }
        if (!choice) {
          if (!list.length) throw Object.assign(new Error('No wallet found. Get bWalletX at bwalletx.com.'), { code: 'NOT_FOUND' });
          setState((s) => ({ ...s, status: s.identityKey ? 'connected' : 'idle' }));
          return null;
        }
        const cw = await choice.connect();
        let { handle = null, paymail = null } = cw as { handle?: string | null; paymail?: string | null };
        let signedIn = false;
        if (cw.wallet && c.challengeUrl && c.verifyUrl) {
          const r = await signInWithBwalletX({
            wallet: cw.wallet,
            challenge: (identityKey) => postJson(c.challengeUrl!, { identityKey }) as unknown as Promise<Challenge>,
          });
          const v = await postJson(c.verifyUrl, { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature });
          handle = (v.handle as string | undefined) ?? handle;
          paymail = (v.paymail as string | undefined) ?? paymail;
          signedIn = true;
        }
        payer.current = cw.payer;
        setState({
          status: 'connected',
          identityKey: cw.identityKey,
          handle,
          paymail,
          wallet: cw.wallet,
          walletId: cw.optionId,
          transitional: !!cw.transitional,
          signedIn,
          error: null,
        });
        return cw;
      } catch (e) {
        if ((e as Error)?.message === 'cancelled') {
          setState((s) => ({ ...s, status: s.identityKey ? 'connected' : 'idle' }));
          return null;
        }
        throw fail(e);
      }
    },
    [fail, listWallets],
  );

  const disconnect = useCallback(async () => {
    const c = props.current;
    if (c.logoutUrl) await postJson(c.logoutUrl, {}).catch(() => {});
    if (state.walletId === 'bwalletx-pairing') await clearPairing();
    payer.current = null;
    setState(empty);
  }, [state.walletId]);

  const need = () => {
    if (!payer.current) throw new PaymentError('NOT_SUPPORTED', 'Connect a wallet first (connect()).');
    return payer.current;
  };

  const value = useMemo<BwalletXContextValue>(
    () => ({
      ...state,
      wallets,
      connect,
      disconnect,
      listWallets,
      pay: (req) => pay(need(), req, props.current.payOptions),
      tip: (req) => tip(need(), req, props.current.payOptions),
      buyToken: (req) => buyToken(need(), req),
    }),
    [state, wallets, connect, disconnect, listWallets],
  );

  return createElement(Ctx.Provider, { value }, p.children);
}

/** The wallet + session state. Must be inside <BwalletXProvider>. */
export function useBwalletX(): BwalletXContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBwalletX() must be used inside <BwalletXProvider>');
  return v;
}

export { handcashAdapter, brc100Option, pairingOption, discoverWallets } from './wallets.js';
export type { WalletOption, ConnectedWallet, HandCashAdapterOptions } from './wallets.js';
export { PaymentError } from './pay.js';
export type { PayRequest, PayResult, BuyTokenRequest, PayOptions } from './pay.js';
/** Alias with the casing used by <BwalletxSignin>. */
export const BwalletxProvider = BwalletXProvider;
