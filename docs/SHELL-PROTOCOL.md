# bApp shell protocol (`bapp:*` messages)

How a bApp and bWalletX talk when the app runs inside the wallet. The web package
(`@bwalletx/connect/shell`, `ShellBridge`) implements the app side. Version 1.

## Manifest

The app serves `/.well-known/bapp.json` (schema: `schema/bapp.schema.json`, validator:
`validateManifest()`). The wallet reads it when it opens the app and draws the five slots
(Wallet · Exchange · (b) · Feed · Chat) in its native dock, plus the app icon button in its top bar.
Every path in the manifest is same-origin. A slot with `"enabled": false` is drawn greyed out and
cannot be tapped; slots are never hidden.

## Detecting the wallet

| How | Signal | Who sends wallet messages |
|---|---|---|
| Native app webview | UA contains `bWallet/`, `YoursWalletMobile/` or `bWalletInset/<n>` (`n` = bottom inset in px) | the wallet injects them into the page: `event.source === window` (or `null`), `event.origin === location.origin` |
| Framed (web wallet, extension) | the parent posts `bapp:hello` | `event.source === window.parent` and `event.origin` is in the allowlist |

The default allowlist is `https://web.bwalletx.com` and `https://bwalletx.com` (exact match). An
app adds the extension origin with `walletOrigins`. Messages from any other window or origin are
dropped without reply.

When the wallet is detected the package sets `data-bwx-in-wallet` on `<html>`, fires a
`bapp-wallet` event on `window`, and `<bwalletx-bar>` hides itself (the native dock replaces it).
`<bwalletx-topbar>` then shows ☰ (wallet menu) first, the app icon second, and ✕ on the right.

## Wallet → app

| Message | Meaning | App does |
|---|---|---|
| `{type:'bapp:hello', v:1}` | framed handshake | records the parent + origin, replies `bapp:ready` |
| `{type:'bapp:navigate', v:1, slot}` | user tapped a dock slot | checks `slot` is one of `wallet, exchange, b, feed, chat` **and** enabled in the manifest, then fires a cancelable `bapp-navigate {slot, path, source:'wallet'}` on `window`; if not prevented, `location.assign(path)` with the manifest path. Replies `bapp:active`. |

`bapp:navigate` never carries a URL. Any `path`, `url` or other field in the message is ignored:
the destination always comes from the app's own manifest.

## App → wallet

| Message | When |
|---|---|
| `{type:'bapp:ready', v:1, manifest:'/.well-known/bapp.json', slot?}` | reply to `bapp:hello` |
| `{type:'bapp:active', v:1, slot}` | the visible slot changed (set `bar.active = 'feed'` or call `bridge.setActive('feed')`) so the dock lights the right tab |
| `{type:'bapp:menu'}` | ☰ tapped in the app's top bar |
| `{type:'bapp:close'}` | ✕ tapped, or "Back to bWalletX" in the drawer |

Framed: sent with `parent.postMessage(msg, <the wallet's exact origin>)`, never `'*'`. Native: sent
with `window.ReactNativeWebView.postMessage(JSON.stringify(msg))` when present.

## Wallet side (Phase 3, for the wallet repo)

- Accept `bapp:*` only from the frame/webview the wallet opened, and only from the manifest's exact origin.
- Send only slot ids, never URLs.
- Read the manifest from the app's origin; ignore any slot whose path fails `isSameOriginPath`.

## Not in Phase 1

- Hold-to-talk on (b). The web bar fires `bapp-b-press` (tap) and `bapp-b-hold {phase:'start'|'end'}` only.
- Like-to-fund purchases. The manifest's `like` block is config only.
- Desktop left-rail layout (≥900px).
