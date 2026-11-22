# Changelog

## 0.9.0 (unreleased)

Sign in with bWalletX on a phone, on the same phone (P0, 22 Nov 2026: "it has never worked"). Three gaps, all on one
device: the site's tab is frozen while the user is in bWalletX, the wallet never sent the user back, and the sign-in
needed a second trip to the wallet that the user never made.

- **The relay socket dying is not a failure.** iOS kills a frozen tab's socket. Before, `pairBwalletX` rejected ("The
  connection to bWalletX closed before pairing finished") and every waiting call rejected ("The connection to bWalletX
  closed"), so the page sat on the code. Now the socket is reopened when the page is back (`visibilitychange`,
  `pageshow`, `online`, `focus`, `hashchange`; new `onWake` option, `onPageWake` export), the relay's queued hello and
  ready finish the pairing, and unanswered calls are re-sent with the same ids when the wallet says `ready` again
  (bWalletX answers a repeated id from its stored answer, never twice).
- **Same phone: back to the site.** `pairingModal()` on a phone sets `returnTo` (this page's origin + path; never its
  query or fragment). The link carries `ret` (this origin's root only), a one-time `rid` and the browser `b`; the
  pairing and the page are saved in localStorage under the rid. bWalletX (5.2.61+) opens `<root>#bwx=ok&rid=…&wk=…&f=…`
  after Connect, usually in a NEW tab. **`resumeReturnedPairing()`** (new) finishes the pairing there. The fragment is
  only a claim (anyone with the link can forge one): its `ready` is used once the relay's wallet says hello with the
  same key. It returns the starting `page`; the provider and `<bwalletx-signin>` post the sign-in to `verifyUrl` and
  go back to it. The tab that started it stops (`RETURNED_IN_ANOTHER_TAB`) and re-reads `sessionUrl`.
- **Only reads and the sign-in are re-sent** after a reconnect (`safeToResend`). A spend or other acting call is sent
  once: it waits for its own answer and times out as `NO_ANSWER_MAYBE_SENT` ("check bWalletX before you try again").
- Only a call that actually reached a socket counts as sent: an unsent spend goes out once when the link is back; a
  sent one is never re-sent. A pairing whose return another tab took stops (`RETURNED_IN_ANOTHER_TAB`) instead of
  finishing a second sign-in. Return entries (they hold the pairing key) are deleted once taken, and stale ones (over
  10 minutes) are removed whenever a pairing starts or resumes.
- **No origin proofs** (review 3, 22 Nov 2026): a proof route can't tell a browser from a script, so it is gone (no
  keys, no routes). bWalletX returns to the root of the relay-seen origin; every sheet over the relay keeps "a site that
  claims to be". **The return fragment is stripped at module load** and on `hashchange` (`hasReturnFragment()`): load
  connect before third-party scripts.
- **The sign-in signature travels only in the return fragment** (CTO 22 Nov 2026). Over the relay bWalletX sends
  `ready` with `ls: 1` ("signed in, see the return") and no signature; a site ignores any `login` that arrives over the
  relay. After `ls` the page waits for the return (`returnWaitMs`, default 20 s), then pairs without it and asks for the
  sign-in the usual way. README "Sign in on the same phone" lists which threat each piece stops.
- **One trip to the wallet.** For phone pairing the challenge is fetched first and folded into the link (`ln`, `lx`;
  `PairingOptions.login`, `ConnectOptions.login`): bWalletX shows one card, "Connect and sign in", and its `ready`
  carries the signature. The paired wallet answers that sign-in itself (`PairedWallet.signedIn`). Only the standard
  `createChallenge` text is folded (`foldableLogin`); a custom challenge goes the usual way. With an older bWalletX the
  modal says to approve the sign-in in bWalletX and links `bwalletx://open`.
- **The provider and the element re-read `sessionUrl` when the page comes back** while signed out (no wallet call).
- Cancel on the site sends the wallet a sealed `close`, so its Connect card doesn't stay up.

## 0.8.0 (unreleased)

`@bsv/sdk` 4.x as connect's own dependency, on top of 0.7.0. (This work was first prepared as "0.6.0" on a branch from 0.5.5; that number was already used for the auto-connect line below, and npm's `latest` is 0.7.0, so it ships as 0.8.0.)

- **`@bsv/sdk` is now connect's own dependency (^4.0.1), not a peer.** Apps that cannot move off @bsv/sdk 1.9 (b0ase.com is on 1.9.31: 2.x signing requires `input.sourceTXID === sourceTransaction.id()`, which breaks its stand-in source transactions and js-1sat-ord) now run connect on its own 4.x copy instead of their 1.9 one: the wallet clients connect builds (the XDM wallet in the bWalletX frame, `probeLocal` desktop wallets, and 0.7.0's Metanet Desktop client, `metanetOption()` / `WalletClient('json-api')`) are 4.x `WalletClient`s, with argument and answer validation. Wallets the page already has (extension announcement, `window.CWI`, phone pairing) are used as they are, as before. 4.x, not 2.x: it is npm's `latest` (4.1.1), the current `@1sat/*` packages need ^4.0.0, and `WalletClient` and the XDM substrate are byte-for-byte the same as 2.8.11 (the validation changes since then cover certificates and balance queries only).
  - The peer is removed, not kept as an optional types-only peer: with any `@bsv/sdk` peer present, pnpm links connect to the app's copy (checked: a 1.9.31 host resolved connect to 1.9.31, a 2.8.11 host to 2.8.11), which is what this change exists to stop.
  - Apps on 4.x share one copy. Apps on 1.9 or 2.x get two: about 417 KB minified (about 125 KB gzipped) more in a browser bundle. See README, Requirements.
- **Node 22 or later** (`engines.node` `>=22`, was `>=20`): @bsv/sdk 4.x declares `node >=22`, and it is now a hard dependency, so Node 20 installs warn (and fail under `engine-strict`).
- **Payment verification for apps on @bsv/sdk 1.9** (b0ase.com) now runs on connect's 4.x copy, which differs from 1.9 in three visible ways: a raw transaction with trailing bytes is refused (`BAD_TX`; 1.9 accepted it, under a txid that hashed the junk); the chain tracker's `isValidRootForHeight` must return exactly `true` (1.9 accepted any truthy value); and coinbase maturity is checked the right way round (1.9's test was inverted: it accepted a 10-deep coinbase spend and refused a 200-deep one). 4.x also adds structural checks (a sourceTXID must match its source transaction; no duplicate outpoints; no zero-input or zero-output unmined transaction; satoshi bounds). Nothing 2.x refused is accepted. Apps on 2.x see no change. Connect's own checks (amount, exact script, distinct outputs, txid) are unchanged.
- **XDM calls time out.** In the bWalletX frame, every wallet call over XDM now fails after `XDM_RESPONSE_TIMEOUT_MS` (10 minutes, new export) if the parent never answers, instead of waiting forever; on an answer, an error or the timeout its message listener is removed and its timer cleared (tested). A timed-out `pay()` reports `maybeSent: true`: reconcile with `verifyPayment` before offering a retry (README). Only a trusted message from `window.parent` at the exact bWalletX origin, with the call's id, is taken as the answer; answers from another origin or window are ignored (tested). For apps on 1.9 this is new: 1.9's XDM checked neither origin nor source.
- **`Brc100Wallet`** (new type): every public parameter that takes a wallet (`SignInOptions.wallet`, `waitIfLocked`, `pay`/`tip`/`buyToken` via `PaySource`, `proveHoldings`, `RequestAccessOptions.wallet`, `brc100Option`, `cwiIsAnnounced`, and 0.7.0's `MetanetOptions.make` for `metanetOption`, `connectMetanetDesktop`, `trySilentMetanet` and `runSilentMetanet`, which also needs `getVersion`) accepts any BRC-100 wallet from any `@bsv/sdk` version, or a plain object with the same methods. Widened, not changed: everything that compiled before still does. A wallet you pass in comes back as the same object.
- **Types now come from connect's own `@bsv/sdk`.** Before, connect's `.d.ts` files resolved `@bsv/sdk` to the app's copy; now they resolve to connect's 4.x. Wallets connect returns are typed as 4.x `WalletInterface`; a 1.9-typed codebase that assigns one to its own `WalletInterface` type needs a cast. This is why the version is a minor bump.
- No `@bsv/sdk` object crosses the API in either direction (audit in this release, 0.7.0 additions included): payments, signatures, keys and BEEF go in and out as strings and byte arrays, as before.
- **Licences for the one-script-tag build.** `dist/bwalletx-connect.global.js` bundles @bsv/sdk (4.1.1 at this lockfile: Apache-2.0, with a NOTICE, PATENTS, THIRD_PARTY_NOTICES.md and LICENSES/ that its README says to keep with browser bundles) and qrcode-generator (MIT); until now it carried none of their notices. It now starts with a licence banner (versions and licences read from the installed packages at build time), and the package ships `THIRD_PARTY_LICENSES.md` plus @bsv/sdk's notices verbatim in `third-party/bsv-sdk/` (`files`). `scripts/third-party-licenses.mjs` regenerates them; a test and `prepublishOnly` fail when they no longer match the installed packages. (A 4.0.1 install is under the Open BSV licence instead; the banner names whichever was bundled.)
- Docs: the one-script-tag build is about 555 KB minified (170 KB gzipped) with 0.7.0's code, not 125 KB.

## 0.7.0 (published 6 Nov 2026)

**Use Metanet Desktop or another BRC-100 wallet** (owner, 6 Nov 2026: "ship a new one now with the metanet option"), with the rules of the live bChatX door (bit-sign 73f7d644).

- **An explicit, visible choice.** "Use Metanet Desktop or another BRC-100 wallet · Metanet Desktop must be running on this computer": a link under `<bwalletx-signin>` (lg/md; `metanet="auto|on|off"`, React `metanet`), the chooser row that replaces "Desktop wallet", `useBwalletX().connectMetanet()` / `connect({ metanet: true })`, `runConnect({ metanet: true })`, `metanetOption()`. Pinned to `WalletClient('json-api')` on localhost:3321, never `'auto'`; it calls :3321 only after its own tap (getVersion first, so "nothing there" says "We couldn’t reach Metanet Desktop. Open it, then try again.").
- **bWalletX stays the default.** The button's discovery never picks Metanet, even when it is the remembered wallet (`matchRemembered` → null); a remembered Metanet shows no "Continue with your wallet" or Switch note (`tapGoesElsewhere`).
- **Remembered:** the type (`bwx:wallet = { type: 'metanet', substrate: 'json-api' }`) and the identity keys known on this origin (`bwx:known-keys`, public keys, newest 8; `knownIdentityKeys`, `isKnownIdentityKey`, `rememberKnownIdentityKey`). Every successful connect or sign-in adds its key.
- **Return visit:** `planAutoConnect` → `'silent-metanet'`; ONE silent attempt per page load, 2 s (`trySilentMetanet`, `runSilentMetanet`), only for a key already known here; a locked, slow, absent or unknown wallet stops silently (no banner, no retry, no unlock prompt). With a session it attaches only the session's key. The element and the provider both run it.
- **"Not you? Use another wallet"** under the button while Metanet is remembered (element `notYou()`, event `bwalletx-not-you`, `useBwalletX().forgetWallet()`), and Disconnect, forget the choice; a sign-in dropped mid-way lands nobody.
- **Computers only**, never in a frame (`metanetOffered()`, `inAnyFrame()`); the chooser row is hidden there too.
- **The minimum asked:** getVersion, isAuthenticated, the identity key, then the site's own call (the sign-in signature), one at a time; no protocol permission requests at connect.
- **No coins:** a `createAction` that fails for lack of funds throws `PaymentError` `INSUFFICIENT_FUNDS` (`maybeSent: false`) with "Your wallet doesn't have enough to cover this payment and its small network fee. Add a little and try again." (`NO_COINS_TEXT`, `isInsufficientFunds`).
- **Security review fixes:** no desktop wallet on localhost (Metanet on 3321, Cicada on 3301, `probeLocal`, a remembered 0.6.0 "Desktop wallet") is ever picked without its own tap: `autoChoice` and `matchRemembered` skip them (`isLocalDesktop`, `isLocalDesktopType`); a remembered `desktop` now plans `'none'`. Identity keys count as known only after a verified sign-in or a session match. `logoutUrl` / `logout-url` is required with `verifyUrl` (dev `console.warn`, `warnIfNoLogout`).
- `isTouchDevice` moved to its own module (still exported from the package root and `modal`).

## 0.6.0 (never published: these changes first shipped in 0.7.0)

Auto-connect for returning visitors (RB, 5 Nov 2026: "go on auto-connect"), within the wallet-choice rules of 0.5.6.

- **The remembered choice.** After a sign-in the user explicitly picked (bWalletX's own button, a pick in the chooser, a site's `walletId`), the wallet TYPE is remembered for this origin: `localStorage['bwx:wallet'] = { type, substrate }`, e.g. `{ "type": "bwalletx", "substrate": "extension" }` or `{ "type": "io.yours", "substrate": "injected" }`. Never a key, address or handle; a bare `window.CWI` is never remembered (whoever holds it next time may be another wallet). `rememberWalletChoice`, `rememberedWalletChoice`, `forgetWalletChoice`.
- **The next tap goes straight to it**, with no chooser, even when it isn't bWalletX (the user chose it). If it isn't here any more: bWalletX if here, else the chooser. A remembered desktop wallet probes localhost only after the tap.
- **Nothing that could prompt fires on load.** `planAutoConnect()`: with a live server session and a remembered injected wallet, the provider picks the wallet up by discovery alone (`attachRemembered`: no wallet call, no localhost, no relay), so `pay`/`tip` work after a reload without another tap. Without a session, a connect would ask the wallet for a key or a signature, so it waits for the tap.
- **"Some features need bWalletX · Switch"** under `<bwalletx-signin>` (lg/md; `switch-note="on|off"`) when the remembered wallet isn't bWalletX, and "Switch to bWalletX" in the signed-in menu. `switchToBwalletX()` on the element and in `useBwalletX()`; the `bwalletx-signin` event carries `mode: 'bwalletx'`. `useBwalletX()` adds `rememberedWallet` and `needsBwalletX`.
- **Disconnect forgets** the remembered wallet (the provider's `disconnect()` and the element's menu).
- Options: `BwalletXProvider rememberChoice` and `autoConnect` (both default true; both off with `fastPath={false}`), `runConnect({ remembered, remember, preferBwalletX })`, `decideWallet({ remembered, preferBwalletX })`, `<bwalletx-signin remember="off">`.
- `<bwalletx-button>` shares the record: a 0.5.5 `bwx:connected` entry (which held the identity key) becomes `{ type: 'bwalletx' }` on load and the key is deleted (`migrateConnectedKey`); a tap on Connect remembers the type; Disconnect forgets it. Still zero wallet calls on load.
- The one-sheet sign-in is unchanged: the identity key and the signature still go to the wallet together.

## 0.5.6 (published 6 Nov 2026)

Wallet choice (RB, 5 Nov 2026: bWalletX is the default on our sites; no other wallet may take the sign-in flow). A fix: sites showed their own chooser even when only bWalletX was present, so users never saw the wallet sheet, and a wallet that held `window.CWI` was treated as bWalletX.

- **bWalletX is recognised by its own announcement only.** `discoverBwalletX()` / `findBwalletX()` / `connectBwalletX()` no longer take `window.CWI` as bWalletX "in-app": Metanet / BSV Desktop or Yours can set or overwrite it. bWalletX is the BRC-100 announcement with rdns `com.bwalletx.extension` (extension) or `space.bwallet.mobile` (in-app browser; every build since 3 Oct 2026 announces), or the bWalletX app frame over XDM. A bare `window.CWI` is listed by `discoverWallets()` as "Browser wallet" (`substrate: 'window.CWI'`) and is never bWalletX.
- **Fast path, on by default.** `decideWallet()` (new, pure) is the rule in `runConnect`, `BwalletXProvider.connect()` and `<bwalletx-signin>`: bWalletX here → straight to its sheet, no chooser, even with other wallets installed. Without it → the chooser, **Get bWalletX** first, then the detected wallets; another wallet is never connected unless picked (0.5.5 connected a lone Yours/Metanet with no picker). `picker: false` now means bWalletX, else the phone, else `NOT_FOUND`. `fastPath: false` restores the 0.5.5 rule.
- **"Other wallets"**: a small link under `<bwalletx-signin>` (lg/md by default; `other-wallets="on|off"`) and in its not-found row; `connect({ chooser: true })` in the provider; the element's `bwalletx-signin` event carries `mode: 'chooser'`.
- **`chooseWallet(list)`**: the new chooser (Get bWalletX first when absent; bWalletX the gold row when present; phone QR; other wallets tagged "Fewer features"; Desktop wallet; HandCash last; Esc / Cancel / backdrop close it). `pickWallet` is unchanged.
- **No localhost probe before a tap.** `desktopOption()` ("Desktop wallet") probes localhost:3321 / 3301 only when its `connect()` runs, after the user picked it. `probeLocal` stays off by default.
- **Telemetry hook**: `onAttempt` (provider prop / `runConnect` option) and the `bwalletx-attempt` event: `{ walletType, substrate, outcome, ms }` per attempt, nothing else.
- `WalletOption.substrate`, `walletTypeOf`, `substrateOf`, `isPresentBwalletX`, `hasBwalletX`, `otherDetected`; `discoverWallets` also finds bWalletX in its app frame (XDM). `useBwalletX().walletType`.
- Element: picking another wallet shows "Approve in your wallet…"; closing the phone QR returns to the button without an error.
- **`<bwalletx-button>`: no wallet calls on load.** It used to call `getPublicKey` on load when `bwx:connected` was set, and stored the identity key there. Now it does discovery only; `bwx:connected` is deleted on load (`dropLegacyConnectedKey`) and never written; a reload shows Connect, and one tap reconnects. New `session-url` shows the chip from your server's session with no wallet call.

## 0.5.5 (unreleased)

- **One wallet sheet to sign in** (owner escalation, 2 Nov 2026: "FIVE PROMPTS??? FOR ONE CONNECTION?" on vexvoid.com). Measured with bWalletX 5.2.48: 0.5.4 asked for a picker plus 3 sheets on localhost, and a picker plus 5 sheets on the live site. Now:
  - `signInWithBwalletX` gets the challenge first, with no key, then sends `getPublicKey({ identityKey: true })` and `createSignature` together (`Promise.all`), so the wallet can show one sheet. `identityKey` reuses a key you already have (the signature alone).
  - `BwalletXProvider.connect()` (and `useBwalletX().connect()`) no longer asks for the key before signing in: the old path asked for it twice (once to connect, once to sign in). Logic in `runConnect()`.
  - **Repeat sign-in is the signature alone**: the key that signed in last is remembered on the site (`rememberedIdentity()`, public data, a hint only). If another account is active, verification fails once and the sign-in is retried with the key asked for (`signInAndVerify`).
  - `waitForAuthentication` is only called when the wallet says it is locked (`waitIfLocked`): bWalletX answers every call by fetching the site's manifest.json and, when that asks for permissions, showing a separate sheet each time.
  - **Picker**: bWalletX is listed once (`window.CWI` is the same extension it announced; `cwiIsAnnounced`). With one wallet in the browser there is no picker at all (`autoChoice`); phone pairing is then a fallback, not a choice.
  - **Server**: `createChallenge({ identityKey })` makes the key optional; a keyless challenge binds the key the browser claims at `verifySignIn`, and the signature only verifies for that key. A challenge made with a key still only verifies for that key. **Upgrade the server too** for one sheet: against a 0.5.4 server the browser falls back to the old order by itself (two sheets), or set `challengeNeedsIdentityKey`.
- **The official element is stateful.** `<bwalletx-signin>` / `<BwalletxSignin>`: signed out → pending ("Approve in bWalletX…" with one line, "Sign in: shares only your public identity key, moves no money"; a body-level tip on `sm`/`icon`) → signed in (a badge: bAvatar, $handle from the paymail lookup or a short key, gold dot) with a menu (Copy paymail/key, Disconnect) → or an error line plus Retry ("Sign-in cancelled" for a no). The menu is a fixed, body-level portal (never clipped by `overflow:hidden`), keyboard operable, and fits a phone. Inside `<BwalletXProvider>` the element follows the provider (click → `connect()`, Disconnect → `disconnect()` → `logoutUrl`, reload restores from `sessionUrl` with no wallet prompt). Standalone: `session-url`, `logout-url`, `lookup-url`; `stateless` keeps the old plain button.
- **`useBwalletXAccount()`**: `{ status, identityKey, paymail, handle, label, avatarUrl, error, login, logout }` for sites with their own UI.
- **`<bwalletx-button>`: the one nav wallet control.** It renders Get bWalletX (deep-linked by platform), Connect bWalletX, or the $handle chip, by state, with the official button look. It guards against duplicates: a second instance and legacy controls in the same header/nav are hidden, with a console warning. Use only this element; don't add your own Get or Connect links.
- **`<bwalletx-signin label="get">` and `label="play"`**: "Get bWalletX" and "Play with bWalletX", the same official button for download and play-now calls to action (with `href` link mode). First users: terrornode.com and tokenblaster.lol.

## 0.5.4 (unreleased)

- **Connect is fast.** A wallet that is present now resolves at once: the extension answers `brc100:requestWallet` synchronously, and `window.CWI` (in-app browser) is taken straight away instead of after the wait. The wait for "nothing here" before the pairing QR drops from 1200 ms to 300 ms (`DEFAULT_DISCOVER_MS`); in a bWalletX frame the XDM probe now starts in parallel. `discoverWallets` stops waiting 50 ms after a wallet has announced. Measured in Chrome: pairing modal 1.24–1.34 s → 0.33–0.34 s after the click.
- **`onStatus`** on `signInWithBwalletX` / `connectBwalletX`: `'finding' | 'opening' | 'pairing' | 'signing'`, so the button can say "Opening your wallet…" the moment it is clicked.
- **`prewarmBwalletX()` / `bindPrewarm(el)`**: on hover, focus or touch, send a prompt-free `isAuthenticated` so a sleeping extension worker starts reopening the wallet before the click (about 0.5 s off a cold Connect). `<bwalletx-signin>` binds it automatically.
- **Security: relay role claims for the site (b-Aware 26 Oct 2026, N3-1/N3-2).** `pairBwalletX` now opens the relay channel with its own random site claim and stores it with the pairing (`sc`); every reconnect sends it, so someone who learns the channel ID can no longer replace your socket or lock you out. It also sends `wc`, the SHA-256 of the wallet claim only the QR can produce (`walletClaimFor(channel, site pubkey)`), so nobody can take the wallet role before the phone scans. Pairings stored by older versions get a claim on their next reconnect. **Upgrade before 30 Nov 2026**: after that the relay refuses new channels without a site claim. See "Relay claims" in the README.

## 0.5.3 (unreleased)

- **Phones get "Open bWalletX", not a QR.** On a touch device (`isTouchDevice()`), `pairingModal()` no longer shows a QR the user would have to scan with the same phone. It shows **Open bWalletX**, a link to the pairing universal link (`https://www.bwallet.space/pair?…`, the iOS universal link / Android app link the app already handles), plus **Use web.bwalletx.com instead** (copies the link and opens the web wallet to paste it), and the match code. The page keeps waiting on the pairing channel, so the user approves in the wallet and comes back. Desktops still get the QR. Force either with `pairingModal({ mode: 'qr' | 'app' })`.

## 0.5.2 (unreleased)

- **Security: framed pages only ask bWalletX itself over XDM.** `findBwalletX` / `discoverBwalletX` in a frame used to post to whatever page framed it and take its answers, so any page that framed your site became "the wallet" (saw every call, could return a fake txid). Now the parent's origin (from `location.ancestorOrigins`, else the referrer) must be one of `BWALLETX_PARENT_ORIGINS` (web.bwalletx.com, bwallet.space, the iOS/Android/Desktop app shells, the Chrome extension); messages go to that exact origin and only its answers count. `probeXdm(ms, allowed)` takes your own list if you host the wallet elsewhere.
- Docs: verify payments on your server (`verifyPayment`); never trust a txid from the page.

## 0.5.0 (unreleased)

- **Site theme in the wallet**: `BwalletXProvider theme="npgx"` (or `declareWalletTheme('npgx')`) declares `<meta name="bwalletx-theme">` while connecting/connected and removes it on disconnect. bWalletX wears that theme for this origin only, from the themes it bundles (brand editions locked to their own sites); only the id is sent, never colours or CSS.
- Sign-in errors carry `err.stage` (`identity` | `challenge` | `signature` | `verify`) with the original message, so a site can say what actually failed instead of guessing from the text.
- **Access protocol v1 ($401 identity / $403 token-gated access)**, spec in `docs/ACCESS-PROTOCOL.md`. Standard BRC-100 calls only, so any BRC-100 wallet works.
- Client: `requestAccess()` signs the site's challenge and proves the keys that hold the token (`proveHoldings()`). Errors are `AccessError` with a protocol code.
- Server: `createAccessChallenge`, `verifyAccess`, `checkTokenHolding`, plus `oneSatResolver()` (1Sat indexer) and `bitSignResolver()` (identity level / KYC). Fails closed: an indexer outage is `indexer_unavailable`, never a grant.
- Next.js: `createBwalletXAccess()` gives challenge, verify, status and logout routes, a signed access cookie, and `getAccess()`, which re-checks holdings every `recheckEvery` seconds so selling the tokens ends access.
- `<bwalletx-signin require-token="bsv21:…" min="100">` runs the access flow and emits `bwalletx-access-granted` / `bwalletx-access-denied`.
- Protocol videos and posters in `assets/protocol/` (401 green, 402 blue, 403 red), exported as `PROTOCOL_MEDIA`.

## 0.4.1 (2026-10-12)

- React: `BwalletXProvider` and `BwalletxSignin` declare `ReactElement` return types, so they type-check as JSX under React 18 `@types/react`.
- First public release of the 0.4 line (0.4.0 was staged on npm but never released).

## 0.4.0 (2026-10-12)

Everything from 0.3 still works the same way. All additions are BRC-100 first: bWalletX is the main target, but any BRC-100 wallet goes through the same interface.

- **React** (`@bwalletx/connect/react`): `<BwalletXProvider>` and `useBwalletX()` give you status, identityKey, handle and paymail, connect/disconnect, the BRC-100 `wallet`, and pay/tip/buyToken. Safe to server-render. `<BwalletxSignin>` is unchanged.
- **Next.js adapter** (`@bwalletx/connect/next`, new): `createBwalletXAuth()` gives you challenge, verify, logout and session route handlers, an HMAC-signed httpOnly session cookie, and `getSession()` for server components. The secret comes from `BWALLETX_SESSION_SECRET` (or `secret`). There is no default, so it throws if the secret is missing.
- **Nonce stores**: `redisStore` (Upstash, node-redis, ioredis) and `pgStore` (any `query` function), plus `pgNonceTableSql()`. `memoryStore` now warns when it runs in production.
- **Sessions**: `signSession`, `verifySession`, `serializeCookie` and `readCookie` (WebCrypto, so they work on Edge).
- **Payments**: `pay` (to a paymail, address or BRC-29 identity key; in sats or USD; optional OP_RETURN memo), `tip`, and a `buyToken` quote hook. Each makes one `createAction` and is never retried. Errors are `PaymentError` with a `code` and a `maybeSent` flag.
- **Server**: `verifyPayment` checks a txid, raw tx, BEEF or Atomic BEEF against the expected outputs, with optional WhatsOnChain or ARC status checks and SPV.
- **Account linking**: `linkIdentity`, `signInOrLink`, and `IdentityLinkConflictError` (the Next adapter turns it into a 409).
- **Wallet picker**: `discoverWallets` finds every BRC-100 wallet that announces itself, plus the in-app wallet, optional localhost desktop wallets and phone pairing. `pickWallet` shows the picker UI. `handcashAdapter` is a transitional slot that wraps an app's own HandCash login and imports no HandCash SDK.
- **Pairing QR modal**: `pairingModal()` and `qrSvg()`, using the bundled `qrcode-generator` (MIT).
- Tooling: ESLint (`pnpm lint`) and a CI workflow on pull requests.

## 0.3.0

- bApp shell: the `bapp.json` manifest, 5-slot bar, top bar, drawer and in-wallet bridge.
