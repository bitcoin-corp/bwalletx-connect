---
name: bwalletx-connect
description: Add "Sign in with bWalletX" (or any BRC-100 wallet) to a website or Next.js/React app with @bwalletx/connect - wallet discovery, one-sheet sign-in against a server challenge, server-side signature verification, sessions, and phone pairing by QR. Use when asked to "add wallet sign-in", "connect a BRC-100 wallet", "sign in with bWalletX", or to verify a BRC-100 identity-key signature on a server.
---

# Sign in with bWalletX (BRC-100)

bWalletX is a BRC-100 wallet. `@bwalletx/connect` (MIT, `pnpm add @bwalletx/connect`) finds the user's wallet through the
open BRC-100 interface, so any BRC-100 wallet works the same way. The user's **identity key** (a 33-byte compressed public
key, 66 hex characters) becomes their user ID on your site. No API key, no client ID, no account with us.

Full protocol: https://bwalletx.com/connect.md. Package docs: the README in this repository.

## Decide first

| Your app | Use |
|---|---|
| Next.js App Router | `@bwalletx/connect/next` (`createBwalletXAuth`) for the four routes, `@bwalletx/connect/react` on the client |
| React, other server | `@bwalletx/connect/react` on the client, `@bwalletx/connect/server` on your server |
| Static page | `<script src="https://bwalletx.com/connect.js">` and `bWalletX.signIn(...)`, plus a server for the two routes |

Sign-in always needs a server: the challenge is made and checked there. Never verify in the browser.

## How the wallet is reached

1. Chrome/Brave extension: BRC-100 discovery (`brc100:requestWallet` → `brc100:announceWallet`, `info.rdns` `com.bwalletx.extension`).
2. Inside the bWalletX app's browser: the same discovery, or `window.CWI`.
3. Phone or web wallet: pairing. Your page shows a pairing link as a QR code; traffic goes end-to-end encrypted through
   `relay.bwallet.space`. Pass a `pairing` option (`onLink`, `onCode`) and show the 4-digit code both screens display.

All three return the same BRC-100 `WalletInterface`.

## Server: two steps

```ts
import { createChallenge, verifySignIn, originAllowed, pgStore } from '@bwalletx/connect/server';

const ORIGIN = process.env.APP_ORIGIN!; // from config, never from the request
const store = pgStore({ query });       // or redisStore({ client }); memoryStore() is for development only

// POST /api/bwalletx/challenge
if (!originAllowed(req.headers.get('origin'), ORIGIN)) return forbidden();
return json(await createChallenge({ origin: ORIGIN, store })); // leave identityKey out: one wallet sheet

// POST /api/bwalletx/verify
if (!originAllowed(req.headers.get('origin'), ORIGIN)) return forbidden();
const { identityKey, nonce, signature } = await req.json();
const proven = await verifySignIn({ origin: ORIGIN, identityKey, nonce, signature, store });
if (!proven) return unauthorized();
// start a session for `proven` (signSession/verifySession are exported too)
```

Next.js shortcut: `createBwalletXAuth({ origin, store, onVerified })` gives `challenge`, `verify`, `logout` and `session`
handlers; export each as the route's `POST`/`GET`. It needs `BWALLETX_SESSION_SECRET` (32+ characters) and throws without it.

## Client (React)

```tsx
<BwalletXProvider challengeUrl="/api/bwalletx/challenge" verifyUrl="/api/bwalletx/verify"
  logoutUrl="/api/bwalletx/logout" sessionUrl="/api/bwalletx/session">{children}</BwalletXProvider>

const { status, identityKey, wallet, connect, disconnect } = useBwalletX();
```

## Guardrails

- The origin comes from your config, never from the request. Check the `Origin` header on both routes.
- Use a shared nonce store (Postgres via `pgNonceTableSql()`, or Redis) in production. The in-memory store loses
  challenges on restart and across serverless instances.
- Each nonce is single-use and expires in 2 minutes; `verifySignIn` deletes it before checking anything.
- Never ask the user for a private key, seed phrase or WIF. The wallet signs; your server only sees the public identity key.
- Session secrets live in environment variables. Never commit them and never give them a default value.
- Next.js: add `suppressHydrationWarning` to `<html>` and `<body>`; the extension sets an attribute before hydration.
- Requires Node 22+ on the server. connect ships its own `@bsv/sdk` 4.x, so your app can keep its own version.
