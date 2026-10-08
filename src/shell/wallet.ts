/**
 * In-wallet mode. Inside bWalletX the wallet draws the dock natively; the app hides its web bar,
 * follows `bapp:navigate {slot}` from the wallet, and reports `bapp:active {slot}` back.
 * Protocol: docs/SHELL-PROTOCOL.md.
 */
import { isSlotId, slotPath, type BappManifest, type SlotId } from './manifest.js';

/** Wallet web origins allowed to drive a framed bApp. Extension origins are passed in by the app. */
export const DEFAULT_WALLET_ORIGINS: readonly string[] = ['https://web.bwalletx.com', 'https://bwalletx.com'];

export type WalletVia = 'ua' | 'frame' | null;
export interface WalletDetection {
  inWallet: boolean;
  via: WalletVia;
  /** Bottom inset (px) the wallet reserves, from `bWalletInset/<n>`. */
  inset?: number;
}

const UA_RE = /\b(?:bWallet|YoursWalletMobile)\//;
const INSET_RE = /\bbWalletInset\/(\d{1,4})\b/;

/** Synchronous detection from the user agent (native app webviews). */
export function detectWalletUA(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): WalletDetection {
  const inset = INSET_RE.exec(ua);
  if (inset || UA_RE.test(ua)) return { inWallet: true, via: 'ua', ...(inset ? { inset: Number(inset[1]) } : {}) };
  return { inWallet: false, via: null };
}

let state: WalletDetection = { inWallet: false, via: null };
/** Current detection (UA, or a completed frame handshake). */
export function walletState(): WalletDetection { return state; }

function setState(next: WalletDetection, win: Window): void {
  state = next;
  if (next.inWallet) win.document?.documentElement?.setAttribute('data-bwx-in-wallet', next.via ?? '');
  win.dispatchEvent(new CustomEvent('bapp-wallet', { detail: next }));
}

export interface ShellBridgeOptions {
  manifest: BappManifest;
  /** Allowed wallet origins for framed mode (exact match). Default DEFAULT_WALLET_ORIGINS. */
  walletOrigins?: readonly string[];
  /** Default: window. */
  win?: Window;
  /** Default: navigator.userAgent. */
  userAgent?: string;
}

type Msg = { type?: unknown; v?: unknown; slot?: unknown };

/**
 * Listens for the wallet and keeps it in sync. Navigation is dispatched as a cancelable
 * `bapp-navigate` event on window ({slot, path, source:'wallet'}); if nobody calls
 * preventDefault() the page goes to the slot's path with location.assign.
 */
export class ShellBridge {
  readonly manifest: BappManifest;
  private readonly origins: readonly string[];
  private readonly win: Window;
  private target: { win: Window; origin: string } | null = null;
  private active: SlotId | null = null;
  private readonly onMessage = (e: MessageEvent) => this.handle(e);
  private readonly onActive = (e: Event) => { const s = (e as CustomEvent).detail?.slot; if (isSlotId(s)) this.setActive(s); };
  private readonly onMenu = () => this.post({ type: 'bapp:menu' });
  private readonly onClose = () => this.post({ type: 'bapp:close' });

  constructor(opts: ShellBridgeOptions) {
    this.manifest = opts.manifest;
    this.origins = opts.walletOrigins ?? DEFAULT_WALLET_ORIGINS;
    this.win = opts.win ?? window;
    const ua = detectWalletUA(opts.userAgent);
    if (ua.inWallet) {
      // Native webview: the wallet injects messages into the page itself.
      this.target = { win: this.win, origin: this.win.location.origin };
      setState(ua, this.win);
    }
  }

  start(): this {
    this.win.addEventListener('message', this.onMessage);
    this.win.addEventListener('bapp-active', this.onActive);
    this.win.addEventListener('bapp-menu', this.onMenu);
    this.win.addEventListener('bapp-close', this.onClose);
    return this;
  }

  stop(): void {
    this.win.removeEventListener('message', this.onMessage);
    this.win.removeEventListener('bapp-active', this.onActive);
    this.win.removeEventListener('bapp-menu', this.onMenu);
    this.win.removeEventListener('bapp-close', this.onClose);
  }

  get inWallet(): boolean { return this.target !== null; }

  /** Tell the wallet which slot is showing (lights up the native dock). */
  setActive(slot: SlotId): void {
    this.active = slot;
    this.post({ type: 'bapp:active', v: 1, slot });
  }

  /** Is this message from a trusted wallet? */
  trusted(e: MessageEvent): boolean {
    const parent = this.win.parent;
    // Framed: only our direct parent, only an allowlisted origin.
    if (parent && parent !== this.win && e.source === parent) return this.origins.includes(e.origin);
    // Native webview (UA detected): injected into this page, so same window and same origin.
    if (this.target?.win === this.win && (e.source === this.win || e.source === null)) return e.origin === this.win.location.origin;
    return false;
  }

  private handle(e: MessageEvent): void {
    const d = e.data as Msg;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !d.type.startsWith('bapp:')) return;
    if (!this.trusted(e)) return;
    if (d.type === 'bapp:hello') {
      if (!this.target) {
        this.target = { win: e.source as Window, origin: e.origin };
        setState({ inWallet: true, via: 'frame' }, this.win);
      }
      this.post({ type: 'bapp:ready', v: 1, manifest: '/.well-known/bapp.json', ...(this.active ? { slot: this.active } : {}) });
      return;
    }
    if (d.type === 'bapp:navigate') {
      if (!isSlotId(d.slot)) return; // never a URL, only a slot id
      const path = slotPath(this.manifest, d.slot);
      if (d.slot !== 'b' && !path) return; // disabled or not in the manifest
      if (d.slot === 'b' && !this.manifest.slots.b.enabled) return;
      const ev = new CustomEvent('bapp-navigate', { cancelable: true, detail: { slot: d.slot, path, source: 'wallet' } });
      this.win.dispatchEvent(ev);
      if (!ev.defaultPrevented && path) this.win.location.assign(path);
      this.setActive(d.slot);
    }
  }

  private post(msg: Record<string, unknown>): void {
    if (!this.target) return;
    const { win, origin } = this.target;
    // Native webviews expose ReactNativeWebView; fall back to postMessage to self.
    const rn = (this.win as unknown as { ReactNativeWebView?: { postMessage(s: string): void } }).ReactNativeWebView;
    if (win === this.win && rn) rn.postMessage(JSON.stringify(msg));
    else win.postMessage(msg, origin);
  }
}

/** Convenience: create and start a bridge. */
export function startShellBridge(opts: ShellBridgeOptions): ShellBridge {
  return new ShellBridge(opts).start();
}

/** Test hook. */
export function _resetWalletState(): void { state = { inWallet: false, via: null }; }
