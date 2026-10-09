# bApps in the wide layout (draft, v2 of the shell protocol)

Owner, 9 Oct 2026: bApps need a format that fits the wide-screen web layout, and the same layout must
port straight into the desktop app. Status: PLAN. Builds on SHELL-PROTOCOL.md (v1, phone dock).

## 1. One layout, three hosts

| Host | Window | Chrome around the bApp |
|---|---|---|
| Phone app / extension popup | narrow | top bar + 5-slot dock (v1) |
| Web wallet, wide (≥1100px) | wide | **left sidebar + top bar** (wide shell) |
| Desktop app | wide | identical to wide web: the desktop app is the web wallet installed from Chrome (PWA, standalone window); Electron/Tauri later reuse the same shell unchanged |

A bApp is written once. It reads which layout it is in and adapts with container queries; the wallet
never asks it to redraw a different app.

## 2. Manifest additions (`/.well-known/bapp.json`)

```json
{
  "wide": {
    "sidebar": { "label": "bMovies", "icon": "/icons/bmovies-64.png", "badge": "live" },
    "sections": [
      { "id": "feed",    "label": "Feed",    "path": "/feed",    "icon": "home" },
      { "id": "make",    "label": "Make",    "path": "/make",    "icon": "spark" },
      { "id": "studios", "label": "Studios", "path": "/studios", "icon": "grid" },
      { "id": "chat",    "label": "Chat",    "path": "/chat",    "icon": "chat" }
    ],
    "panes": "list-detail",
    "minWidth": 720
  }
}
```

- `sidebar`: the bApp's entry in the wallet sidebar (bApps group, pinnable). `badge` is optional:
  `"live"` (red dot) or a number the app sends with `bapp:badge`.
- `sections`: the bApp's own sub-navigation, shown as a second column next to the wallet sidebar
  (like bMail's folders). Same-origin paths only. If omitted, the wide shell maps the v1 `slots`
  (wallet · exchange · b · feed · chat) to sections, so every v1 bApp works in wide without changes.
- `panes`: a layout hint: `single` (default), `list-detail` (list column + detail pane, like bMail),
  or `three-pane`. The app still draws its own panes; the hint lets the wallet size the frame and
  keep its own detail panel closed.
- `minWidth`: below this the wallet shows the phone layout for the app.

## 3. What the wallet draws vs what the app draws

- Wallet: sidebar (wallet sections + bApps), top bar (search/⌘K b agent, scan, notifications,
  currency, account), the bApp's `sections` column, and every money/permission sheet (one-sheet
  permissions, pay, sign). The b button floats over everything.
- App: everything inside its frame. No balance, no send screens, no own wallet (unchanged rule).
- The app hides `<bwalletx-bar>` and `<bwalletx-topbar>` in wide mode, the same way it does inside
  the phone app.

## 4. Messages (additions)

| Message | Direction | Meaning |
|---|---|---|
| `{type:'bapp:layout', v:2, layout:'phone'\|'wide', width}` | wallet → app | sent on open and on resize; the package sets `data-bwx-layout` on `<html>` |
| `{type:'bapp:navigate', v:2, section}` | wallet → app | user picked a section; destination comes only from the manifest (as v1) |
| `{type:'bapp:active', v:2, section}` | app → wallet | highlight the right section |
| `{type:'bapp:badge', v:2, count}` | app → wallet | sidebar badge (number or 0) |
| `{type:'bapp:title', v:2, title}` | app → wallet | window/tab title in desktop mode |

Same origin and source rules as v1: exact origins, never `'*'`, never URLs in wallet messages.

## 5. Keyboard and desktop niceties

- The wallet owns global shortcuts (⌘K, g + key). Inside the frame, the app may declare its own
  (`"shortcuts": [{"key": "n", "label": "New film"}]`) and the wallet lists them in its help.
- Desktop (installed) mode: the wallet sets `bapp:layout` with `layout:'wide'` and
  `standalone:true`; apps can show a denser UI. Window-controls overlay comes later.

## 6. Order of work

1. Wide shell in the web wallet on real data (in progress: bwalletX branch `demo/desktop-shell`).
2. `@bwalletx/connect` 0.4.0: `bapp:layout`, sections, badge, title; validator for the `wide` block.
3. bMovies first (its MAKE/MINT/TRADE/CHAT cards become sections), then bChatX, TokenBlaster.
4. Chrome-installable desktop app: manifest `id`, wide screenshots, install prompt; a `/desktop`
   page once it installs cleanly.
