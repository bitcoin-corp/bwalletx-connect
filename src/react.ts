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
import { declareWalletTheme } from './theme.js';
import { runConnect } from './connect-flow.js';
import { pairingModal } from './modal.js';
import { pickWallet } from './modal.js';
import { discoverWallets, type ConnectedWallet, type WalletOption } from './wallets.js';
import { accountLabel, avatarUrlFor, lookupPaymail, signInErrorText } from './account.js';
import { PaymentError, buyToken, pay, tip, type BuyTokenRequest, type PayOptions, type PayRequest, type PayResult } from './pay.js';
import { defineBwalletxSignin, type SigninBrand, type SigninLabel, type SigninSize, type SigninState, type SigninTheme } from './element.js';

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
  /** Without a provider: GET → { identityKey, handle?, paymail? } restores the signed-in badge on load. */
  sessionUrl?: string;
  /** Without a provider: POST on Disconnect. */
  logoutUrl?: string;
  /** Paymail lookup for the badge; 'off' to skip. */
  lookupUrl?: string;
  /**
   * Show the signed-in badge and the pending / error states (default true). Inside <BwalletXProvider> the button
   * follows the provider: click → connect() (one wallet sheet), badge when signed in, Disconnect → disconnect()
   * (logoutUrl). Set false for the pre-0.5.5 plain button.
   */
  stateful?: boolean;
  'aria-label'?: string;
  className?: string;
  style?: CSSProperties;
  id?: string;
  /** Every click. Call e.preventDefault() to skip the built-in flow. */
  onClick?: (e: CustomEvent<{ element: HTMLElement }>) => void;
  onSignedIn?: (d: SignedInDetail) => void;
  onNotFound?: () => void;
  onError?: (error: unknown) => void;
  /** After Disconnect in the badge menu. */
  onSignedOut?: () => void;
}

/** The element state for the provider's state. */
export function signinStateFor(v: Pick<BwalletXState, 'status' | 'identityKey'>): SigninState {
  if (v.status === 'restoring') return 'restoring';
  if (v.status === 'connecting') return 'pending';
  if (v.status === 'error') return 'error';
  if (v.status === 'connected' && v.identityKey) return 'signed-in';
  return 'signed-out';
}

export function BwalletxSignin(props: BwalletxSigninProps): ReactElement {
  const ref = useRef<HTMLElement>(null);
  const cb = useRef(props);
  cb.current = props;
  const ctx = useContext(Ctx);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const driven = !!ctx && props.stateful !== false;

  useEffect(() => {
    defineBwalletxSignin();
    const el = ref.current;
    if (!el) return;
    const on: [string, EventListener][] = [
      [
        'bwalletx-signin',
        (e) => {
          cb.current.onClick?.(e as CustomEvent<{ element: HTMLElement }>);
          // Inside a provider the click is the provider's connect(): one wallet sheet, and this button follows it.
          const c = ctxRef.current;
          if (!e.defaultPrevented && c && cb.current.stateful !== false) {
            e.preventDefault();
            c.connect().catch(() => undefined);
          }
        },
      ],
      ['bwalletx-signed-in', (e) => cb.current.onSignedIn?.((e as CustomEvent<SignedInDetail>).detail)],
      ['bwalletx-not-found', () => cb.current.onNotFound?.()],
      ['bwalletx-error', (e) => cb.current.onError?.((e as CustomEvent<{ error: unknown }>).detail.error)],
      [
        'bwalletx-disconnect',
        (e) => {
          const c = ctxRef.current;
          if (c && cb.current.stateful !== false) {
            e.preventDefault();
            void c.disconnect().then(() => cb.current.onSignedOut?.());
          }
        },
      ],
      ['bwalletx-signed-out', () => cb.current.onSignedOut?.()],
    ];
    for (const [t, f] of on) el.addEventListener(t, f);
    return () => { for (const [t, f] of on) el.removeEventListener(t, f); };
  }, []);

  const p = props;
  const flag = (v: boolean | undefined) => (v ? '' : undefined);
  const state = driven ? signinStateFor(ctx) : undefined;
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
    'session-url': driven ? undefined : p.sessionUrl,
    'logout-url': driven ? undefined : p.logoutUrl,
    'lookup-url': p.lookupUrl,
    stateless: p.stateful === false ? '' : undefined,
    state,
    'identity-key': driven ? (ctx.identityKey ?? undefined) : undefined,
    paymail: driven ? (ctx.paymail ?? undefined) : undefined,
    handle: driven ? (ctx.handle ?? undefined) : undefined,
    'avatar-url': driven ? (avatarUrlFor(ctx.identityKey) ?? undefined) : undefined,
    error: driven && ctx.status === 'error' ? signInErrorText(ctx.error) : undefined,
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
  /** POST {} (or { identityKey }) → challenge. With verifyUrl, connect() also signs in, in ONE wallet sheet. */
  challengeUrl?: string;
  /** POST { identityKey, nonce, signature } → { identityKey, handle?, paymail? } and sets the cookie. */
  verifyUrl?: string;
  /** POST to clear the cookie on disconnect(). */
  logoutUrl?: string;
  /** GET → { identityKey, handle?, paymail? } to restore a session on load. */
  sessionUrl?: string;
  /** Offer phone pairing with the built-in QR modal. Default true. */
  pairing?: boolean;
  /**
   * Show the built-in picker when there is a real choice. Default true. One wallet found in this browser (and no
   * app-supplied option such as HandCash) is used straight away, with no picker; phone pairing is then not offered.
   */
  picker?: boolean;
  /**
   * Your challenge route is older than 0.5.5 and needs the identity key first (two wallet sheets). Normally not
   * needed: such a server is detected and retried. Upgrade the server to @bwalletx/connect 0.5.5 for one sheet.
   */
  challengeNeedsIdentityKey?: boolean;
  /** Paymail lookup by identity key for the signed-in badge (best effort). Default pay.bwallet.space; 'off' to skip. */
  lookupUrl?: string;
  /** Extra options, e.g. [handcashAdapter({ login })]. */
  extraWallets?: WalletOption[];
  /** Probe desktop wallets on localhost. Default false. */
  probeLocal?: boolean;
  /**
   * A theme the wallet already bundles (e.g. 'npgx') for bWalletX to wear while this site is connected and is the
   * active tab. Declared only while connecting or connected; withdrawn on disconnect. See declareWalletTheme.
   */
  theme?: string;
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

  const themeOn = !!p.theme && (state.status === 'connecting' || state.status === 'connected');
  useEffect(() => {
    if (!themeOn) return;
    declareWalletTheme(p.theme);
    return () => declareWalletTheme(null);
  }, [themeOn, p.theme]);

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
        const r = await runConnect({
          list,
          walletId: opts.walletId,
          picker: c.picker,
          pick: pickWallet,
          challengeUrl: c.challengeUrl,
          verifyUrl: c.verifyUrl,
          challengeNeedsIdentityKey: c.challengeNeedsIdentityKey,
          post: postJson,
        });
        if (!r) {
          setState((s) => ({ ...s, status: s.identityKey && s.signedIn ? 'connected' : 'idle' }));
          return null;
        }
        const cw = r.connected;
        payer.current = cw.payer;
        setState({
          status: 'connected',
          identityKey: r.identityKey,
          handle: r.handle,
          paymail: r.paymail,
          wallet: cw.wallet,
          walletId: cw.optionId,
          transitional: !!cw.transitional,
          signedIn: r.signedIn,
          error: null,
        });
        return { ...cw, identityKey: r.identityKey, handle: r.handle ?? undefined, paymail: r.paymail ?? undefined };
      } catch (e) {
        if ((e as Error)?.message === 'cancelled') {
          setState((s) => ({ ...s, status: s.identityKey && s.signedIn ? 'connected' : 'idle' }));
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

  // Best-effort paymail for the badge when the server did not send one (pay.bwallet.space lookup by key).
  useEffect(() => {
    const key = state.identityKey;
    if (!key || state.paymail || p.lookupUrl === 'off') return;
    let live = true;
    void lookupPaymail(key, p.lookupUrl).then((pm) => {
      if (live && pm) setState((s) => (s.identityKey === key && !s.paymail ? { ...s, paymail: pm } : s));
    });
    return () => {
      live = false;
    };
  }, [state.identityKey, state.paymail, p.lookupUrl]);

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

export type BwalletXAccountStatus = 'restoring' | 'signed-out' | 'pending' | 'signed-in' | 'error';

export interface BwalletXAccount {
  status: BwalletXAccountStatus;
  identityKey: string | null;
  paymail: string | null;
  handle: string | null;
  /** $alice, a site handle, the paymail, or a short key: what the badge shows. */
  label: string | null;
  /** The bAvatar picture for the identity key (gold by default), or null when signed out. */
  avatarUrl: string | null;
  /** One plain line for the last error ("Sign-in cancelled" for a no in the wallet), or null. */
  error: string | null;
  /** Sign in (the provider's connect(): one wallet sheet). Never throws; failures show in `status`/`error`. */
  login(): Promise<void>;
  /** Sign out: the provider's disconnect() (posts logoutUrl). */
  logout(): Promise<void>;
}

/** The account view of a provider state (what useBwalletXAccount returns). */
export function accountFor(v: BwalletXContextValue): BwalletXAccount {
  const status = signinStateFor(v) as BwalletXAccountStatus;
  const signedIn = status === 'signed-in';
  return {
    status,
    identityKey: signedIn ? v.identityKey : null,
    paymail: signedIn ? v.paymail : null,
    handle: signedIn ? v.handle : null,
    label: signedIn ? accountLabel(v) : null,
    avatarUrl: signedIn ? avatarUrlFor(v.identityKey) : null,
    error: status === 'error' ? signInErrorText(v.error) : null,
    login: () => v.connect().then(() => undefined, () => undefined),
    logout: () => v.disconnect(),
  };
}

/** The signed-in account for your own UI: { status, identityKey, paymail, handle, avatarUrl, logout, … }. Inside <BwalletXProvider>. */
export function useBwalletXAccount(): BwalletXAccount {
  return accountFor(useBwalletX());
}

export { handcashAdapter, brc100Option, pairingOption, discoverWallets, autoChoice } from './wallets.js';
export type { WalletOption, ConnectedWallet, HandCashAdapterOptions } from './wallets.js';
export { PaymentError } from './pay.js';
export type { PayRequest, PayResult, BuyTokenRequest, PayOptions } from './pay.js';
/** Alias with the casing used by <BwalletxSignin>. */
export const BwalletxProvider = BwalletXProvider;
