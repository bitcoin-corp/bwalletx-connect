/**
 * React wrappers for the bApp shell. The elements do the work; these set the manifest property
 * and wire the events.
 *
 *   import { BappBar, BappTopbar, BappDrawer } from '@bwalletx/connect/shell/react';
 *   <BappTopbar manifest={m} drawer="sections" />
 *   <BappDrawer id="sections" manifest={m} />
 *   <BappBar manifest={m} active="feed" onNavigate={(d, e) => { e.preventDefault(); router.push(d.path) }} />
 */
import { createElement, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { defineBappShell } from './elements.js';
import type { BappManifest, SlotId } from './manifest.js';

export interface NavigateDetail { slot?: SlotId; path: string | null; source: 'web' | 'wallet' }
type Handler<D> = (detail: D, event: CustomEvent<D>) => void;

interface Common {
  manifest: BappManifest | null;
  /** "auto" (default) detects bWallet; true/false forces. */
  inWallet?: boolean | 'auto';
  /** true = never call location.assign; route in onNavigate. */
  manualNavigation?: boolean;
  onNavigate?: Handler<NavigateDetail>;
  id?: string;
  className?: string;
  style?: CSSProperties;
  /** Slotted content, e.g. <button slot="tools"> or <span slot="strip-left">. */
  children?: ReactNode;
}

function useShell(tag: string, props: Common, attrs: Record<string, string | undefined>, events: Record<string, Handler<any> | undefined>) {
  const ref = useRef<HTMLElement & { manifest: BappManifest | null }>(null);
  useEffect(() => { defineBappShell(); }, []);
  useEffect(() => { if (ref.current) ref.current.manifest = props.manifest; }, [props.manifest]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const all = { 'bapp-navigate': props.onNavigate, ...events };
    const subs = Object.entries(all).filter(([, h]) => h).map(([type, h]) => {
      const fn = (e: Event) => h!((e as CustomEvent).detail, e as CustomEvent);
      el.addEventListener(type, fn);
      return () => el.removeEventListener(type, fn);
    });
    return () => subs.forEach((u) => u());
  });
  const a: Record<string, unknown> = { ref, id: props.id, class: props.className, style: props.style };
  if (props.inWallet !== undefined && props.inWallet !== 'auto') a['in-wallet'] = String(props.inWallet);
  if (props.manualNavigation) a.navigate = 'manual';
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) a[k] = v;
  return createElement(tag, a, props.children);
}

export interface BappBarProps extends Common {
  active?: SlotId | null;
  onActive?: Handler<{ slot: SlotId }>;
  onBPress?: Handler<{ path: string | null }>;
  onBHold?: Handler<{ phase: 'start' | 'end' }>;
}
export function BappBar(p: BappBarProps) {
  return useShell('bwalletx-bar', p, { active: p.active ?? undefined }, { 'bapp-active': p.onActive, 'bapp-b-press': p.onBPress, 'bapp-b-hold': p.onBHold });
}

export interface BappTopbarProps extends Common {
  title?: string;
  subtitle?: string;
  /** id of the <bwalletx-drawer> the app icon opens. */
  drawer?: string;
  /** Show ☰ on the web too (it always shows in the wallet). */
  menu?: boolean;
  strip?: boolean;
  onMenu?: Handler<object>;
  onClose?: Handler<object>;
  onDrawerToggle?: Handler<object>;
}
export function BappTopbar(p: BappTopbarProps) {
  return useShell('bwalletx-topbar', p, {
    title: p.title, subtitle: p.subtitle, drawer: p.drawer, menu: p.menu ? 'true' : undefined, strip: p.strip === false ? 'off' : undefined,
  }, { 'bapp-menu': p.onMenu, 'bapp-close': p.onClose, 'bapp-drawer-toggle': p.onDrawerToggle });
}

export interface BappDrawerProps extends Common {
  open?: boolean;
  /** Path to highlight; default location.pathname. */
  current?: string;
  onClose?: Handler<object>;
}
export function BappDrawer(p: BappDrawerProps) {
  return useShell('bwalletx-drawer', p, { open: p.open ? '' : undefined, current: p.current }, { 'bapp-close': p.onClose });
}

export type { BappManifest, SlotId } from './manifest.js';
