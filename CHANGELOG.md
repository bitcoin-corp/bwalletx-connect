# Changelog

## 0.5.0 (unreleased)

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
