/**
 * React wrapper for <bwalletx-signin>. React is an optional peer dependency; the button itself is
 * the web component, so markup and behaviour are identical everywhere.
 *
 *   import { BwalletxSignin } from '@bwalletx/connect/react';
 *   <BwalletxSignin challengeUrl="/auth/bwalletx/challenge" verifyUrl="/auth/bwalletx/verify"
 *     onSignedIn={(d) => router.refresh()} />
 */
import { createElement, useEffect, useRef, type CSSProperties } from 'react';
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

export function BwalletxSignin(props: BwalletxSigninProps) {
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
