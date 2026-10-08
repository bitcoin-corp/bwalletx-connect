# @bwalletx/connect

Add "Sign in with bWalletX" to a website.

The user's wallet signs a one-time challenge from your server with a key derived from its identity key. Your server checks the signature and signs the user in as that identity key. You don't need an API key or an account with us, and nothing passes through bwalletx.com. The only service of ours involved is the encrypted pairing relay (`relay.bwallet.space`), and only when the user signs in from a phone or the web wallet.

The full protocol is described at https://bwalletx.com/connect.md. This package is the same code, packaged.

## Install

```sh
pnpm add @bwalletx/connect @bsv/sdk
```

`@bsv/sdk` (2.2 or later, 2.x or 3.x) is a peer dependency.

## The button

`<bwalletx-signin>` is the standard "Sign in with bWalletX" button: a web component with no dependencies (Shadow DOM), plus a React wrapper. It is the gold button from bit-sign's sign-in card.

```html
<script src="https://unpkg.com/@bwalletx/connect@0.2.0"></script>
<bwalletx-signin challenge-url="/auth/bwalletx/challenge" verify-url="/auth/bwalletx/verify"></bwalletx-signin>
<script>
  document.addEventListener('bwalletx-signed-in', (e) => location.assign('/'));
</script>
```

With a bundler: `import '@bwalletx/connect/element'` registers the element. In React:

```tsx
import { BwalletxSignin } from '@bwalletx/connect/react';

<BwalletxSignin challengeUrl="/auth/bwalletx/challenge" verifyUrl="/auth/bwalletx/verify" onSignedIn={(d) => console.log(d.identityKey)} />
```

| Attribute | Values |
|---|---|
| `size` | `lg` (default), `md`, `sm`, `icon` |
| `theme` | `gold` (default), `dark`, `light` |
| `label` | `signin` (default), `continue`, `connect` |
| `brand` | `bWalletX` (default), `bWallet` (store edition) |
| `subtitle` | `on`, `off`, or your own text. Default "also works with bWallet" on lg/md |
| `full-width`, `loading`, `disabled` | flags |
| `challenge-url`, `verify-url` | run the sign-in flow on click: POST `{ identityKey }`, then POST `{ identityKey, nonce, signature }` |
| `get-url`, `web-url` | where "Get bWalletX" and the web wallet link go (bwalletx.com/get, web.bwalletx.com) |
| `href` | navigate on click instead |
| `authorize-url`, `client-id`, `redirect-uri`, `scope` | OAuth 2.1 redirect with S256 PKCE (verifier, state and nonce in `sessionStorage["bwalletx:oauth"]`). For auth.bwalletx.com, which is planned and not live yet |

Events (bubbling, composed): `bwalletx-signin` on every click (call `preventDefault()` to run your own flow instead), `bwalletx-signed-in` with `{ identityKey, method, nonce, signature, response }`, `bwalletx-not-found` (the button then shows "Get bWalletX" and a web wallet link), `bwalletx-error` with `{ error }`.

Without `challenge-url`, `href` or `authorize-url` the button only fires `bwalletx-signin`. The built-in flow uses the extension or in-app browser only. For phone pairing, listen for `bwalletx-signin`, call `preventDefault()`, and call `signInWithBwalletX` with `pairing` as shown above.

SVG files, and an HTML/CSS version with no JavaScript, are in `assets/`. All variants: `examples/buttons.html`. Placement, sizes and do/don't: [BRAND.md](./BRAND.md). The names and logo are not MIT licensed: [TRADEMARKS.md](./TRADEMARKS.md).

## Server

```ts
import { createChallenge, verifySignIn, originAllowed, memoryStore } from '@bwalletx/connect/server';

const ORIGIN = 'https://example.com'; // your site, from config. Never from the request.
const store = memoryStore();          // dev only. See "Nonce store" below.

// POST /auth/bwalletx/challenge   body: { identityKey }
app.post('/auth/bwalletx/challenge', async (req, res) => {
  if (!originAllowed(req.get('origin'), ORIGIN)) return res.status(403).end();
  try {
    res.json(await createChallenge({ origin: ORIGIN, identityKey: req.body?.identityKey, store }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /auth/bwalletx/verify   body: { identityKey, nonce, signature }
app.post('/auth/bwalletx/verify', async (req, res) => {
  if (!originAllowed(req.get('origin'), ORIGIN)) return res.status(403).end();
  const identityKey = await verifySignIn({ origin: ORIGIN, store, ...req.body });
  if (!identityKey) return res.status(401).json({ error: 'That signature was not accepted. Start again.' });
  // Find or create the user keyed on identityKey, then start your own session.
  res.json({ identityKey });
});
```

`verifySignIn` returns the identity key (66 lowercase hex characters) or `null`. It refuses a nonce that was already used, has expired (2 minutes), was issued for another origin or another identity key, or whose signature doesn't verify.

The text the wallet signs:

```
Sign in to example.com with bWallet

This proves you hold this wallet. It does not spend anything.

Origin: https://example.com
Nonce: <nonce>
Expires: <ISO time>
```

It is signed with BRC-100 `createSignature`, protocol `[2, 'bwallet sign in']`, keyID = the nonce, counterparty `'anyone'`. bChat and bit-sign use the same format.

### Nonce store

```ts
interface NonceStore {
  put(nonce: string, c: PendingChallenge): Promise<void> | void;
  take(nonce: string): Promise<PendingChallenge | null> | PendingChallenge | null; // read AND delete
}
```

`take` must read and delete in one step. `verifySignIn` calls it before checking anything else, so each nonce gets exactly one attempt.

`memoryStore()` keeps challenges in the process. It is lost on restart and isn't shared between processes or serverless instances, so it prints a warning the first time it is used. If you leave out `store`, a shared in-memory store is used and you get the same warning. In production, use Redis (`GETDEL`) or a database row you delete with `DELETE ... RETURNING`.

Also rate-limit the challenge route per IP. It is unauthenticated.

## Browser

```ts
import { signInWithBwalletX, renderButton } from '@bwalletx/connect';
import QRCode from 'qrcode'; // any QR library

const panel = document.getElementById('bwx-pair')!;

renderButton('#bwx-button', {
  onClick: async (button) => {
    button.disabled = true;
    try {
      const r = await signInWithBwalletX({
        challenge: (identityKey) => post('/auth/bwalletx/challenge', { identityKey }),
        pairing: {
          onLink: async (link) => {
            panel.innerHTML = `<img src="${await QRCode.toDataURL(link)}" alt="Scan with bWalletX">`;
          },
          onCode: (code) => panel.append(`Check bWalletX shows ${code}, then tap Connect.`),
        },
      });
      await post('/auth/bwalletx/verify', { identityKey: r.identityKey, nonce: r.nonce, signature: r.signature });
      // r.method is 'extension', 'in-app' or 'pairing'
    } finally {
      button.disabled = false;
    }
  },
});

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}
```

`signInWithBwalletX` finds a wallet in this order:

1. The bWalletX Chrome extension: BRC-100 discovery, `rdns` `com.bwalletx.extension`. Gives `method: 'extension'`.
2. The bWalletX app's in-app browser: `rdns` `space.bwallet.mobile`, or `window.CWI` if nothing announced. Gives `method: 'in-app'`. Note that `window.CWI` can also be set by another wallet.
3. A pairing stored by an earlier sign-in on this browser (`reusePairing`, default on).
4. A new pairing, if you passed `pairing`. Show the link as a QR code for the phone, and as text the user can paste into web.bwalletx.com. Both screens show the same 4-digit code. Gives `method: 'pairing'`.

If none of these works, it throws an error with `code: 'NOT_FOUND'`.

It returns `{ identityKey, signature, nonce, method, wallet }`. Post the first three to your verify route. `wallet` is a BRC-100 `WalletInterface` you can keep using.

### Lower-level pieces

| Export | What it does |
|---|---|
| `findBwalletX(ms?)` | The extension or in-app wallet, or `null`. |
| `discoverBwalletX(ms?)` | The same, plus `method` and `rdns`. |
| `pairBwalletX({ onLink, onCode, storage?, signal?, socket?, origin?, relay? })` | Pair over the relay. Resolves with a wallet when the user taps Connect. |
| `restorePairing({ storage? })` | The wallet from a stored pairing, or `null`. It connects on the first call. |
| `clearPairing()` | Delete the stored pairing without telling the wallet. |
| `wallet.close()` / `wallet.forget()` | On a paired wallet: close the socket, or unpair and delete it. |
| `connectBwalletX(opts)` | The wallet-finding half of `signInWithBwalletX`. |
| `renderButton(el, { onClick?, subtitle? })` | Draws the gold button into `el`. |
| `inOrder(handler)` | Wraps an async WebSocket handler so frames run one at a time, in order. |

### Pairing storage

The pairing is saved under `bwalletx.connect.pairing.v1` in `localStorage` by default. It holds a random pairing key (not a wallet key), the wallet's pairing public key, the channel, and the message counters. To store it elsewhere, pass `storage` (anything with `getItem`, `setItem` and `removeItem`, sync or async). Pass `storage: null` to keep it in memory only.

### Frame order

The phone sends a plain `hello` and then, as soon as the user taps Connect, an encrypted `ready`. An async `onmessage` handler that is still deriving the key from `hello` when `ready` arrives drops `ready`, and pairing never finishes. This package handles frames one at a time in arrival order (`inOrder`). `test/pair.test.ts` reproduces the race.

## One script tag

```html
<script src="https://unpkg.com/@bwalletx/connect/dist/bwalletx-connect.global.js"></script>
<script>
  const { signInWithBwalletX, renderButton } = window.bWalletXConnect;
</script>
```

This build includes `@bsv/sdk` (about 125 KB minified). The server functions are not in it.

## Limits

- You get the identity key and nothing else: no handle, paymail or name.
- The identity key is the same on every site that uses this method, so two sites can tell it is the same wallet.
- `relay.bwallet.space` is run by The Bitcoin Corporation. It has no published uptime guarantee and allows about 60 frames a minute per channel.
- There is no hosted sign-in page or OAuth-style redirect. You run the two routes yourself.

## Testing

```sh
pnpm test        # unit tests: challenge/verify, frame order, reload, sign-in paths
pnpm test:live   # pairs with a simulated phone over the real relay.bwallet.space
```

To test your own server without a wallet, sign with `new ProtoWallet(PrivateKey.fromRandom()).createSignature(...)` using the same arguments. That is the signature bWalletX makes.

`src/protocol.ts` is copied unchanged from bWalletX `src/pair/protocol.ts`. Don't edit it; the app must understand every byte.

## License

MIT
