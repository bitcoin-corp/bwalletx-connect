# bWalletX access protocol, v1 ($401 / $402 / $403)

"Sign in with bWalletX, holding N of token X." A site's server issues a challenge, the wallet signs
it with standard BRC-100 calls, and the server verifies the signature and the holdings against an
indexer. Any BRC-100 wallet can answer. bWalletX recognises the protocol ID and shows the right
prompt.

| Kind | Meaning | Colour | Video |
|------|---------|--------|-------|
| `401` | Identity: prove who you are, optionally at an identity level or with KYC | green `#22c55e` | `assets/protocol/401.mp4` (poster `.jpg`) |
| `402` | Payment: pay for content (the challenge kind is reserved; payment uses `pay()`) | blue `#3b82f6` | `assets/protocol/402.mp4` |
| `403` | Access: prove you hold N of a token, or N basis points of its supply | red `#ef4444` | `assets/protocol/403.mp4` |

The SDK exports these as `PROTOCOL_MEDIA` and `protocolMediaUrl(kind, 'video' | 'poster', version)`.
Wallets and sites must use the same files.

## 1. Challenge

The site's server builds the challenge (`createAccessChallenge`) from its own config, never from the
request. The challenge is **canonical JSON**: object keys sorted, no whitespace, absent fields left
out. The exact string is what gets signed and posted back.

```json
{"exp":1760650000,"iat":1760649880,"kind":"403","nonce":"<16-64 base64url>","origin":"https://b0ase.com",
 "require":{"token":{"id":"bsv21:<txid>_<vout>","min":"100000000"}},"sub":"02…","v":1}
```

| Field | Rule |
|-------|------|
| `v` | `1` |
| `kind` | The **primary outcome** the site wants: `403` for entry, `401` for identity only, `402` for a payment |
| `origin` | The site's origin, `scheme://host[:port]`. The wallet must show it and must refuse if it differs from the calling page's origin |
| `nonce` | 16-64 base64url characters. Single use. Also the BRC-100 `keyID` |
| `iat`, `exp` | Seconds since the epoch. Default lifetime 120 s |
| `sub` | Optional. The identity key the site expects. A different wallet account is `wrong_account` |
| `require.token` | `{ id: 'bsv21:<txid>_<vout>', min: '<raw integer string>' }` or `{ id, minBps: 1..10000 }`. Exactly one of `min` / `minBps`. Raw = unscaled by decimals |
| `require.identityLevel` | 1..10. bit-sign levels: 1 Basic (OAuth), 2 Verified (ID docs / self-attestation), 3 Strong (paid signing / peer co-sign), 4 Sovereign (Veriff KYC) |
| `require.kyc` | `true` when a live KYC credential is needed |

`require` lists **prerequisites**. `kind` is what the user is approving.

## 2. What the wallet signs

All signatures cover the same bytes: `UTF-8(challenge string)`.

1. **Identity signature** (every request):

   ```ts
   wallet.createSignature({ protocolID: [2, 'bwalletx access'], keyID: nonce, counterparty: 'anyone', data })
   ```

   The server checks it with `ProtoWallet('anyone').verifySignature({ ..., counterparty: identityKey })`.

2. **Holding proofs** (when `require.token` is set). BRC-100 wallets keep each token output at its
   own derived key, not at the identity key. For each distinct key that locks an unspent output of
   the token, the wallet signs the same bytes with that key's own derivation and reports its public key:

   ```ts
   const { publicKey } = await wallet.getPublicKey({ protocolID, keyID, counterparty })
   const { signature } = await wallet.createSignature({ protocolID, keyID, counterparty, data })
   ```

   For bWalletX and 1Sat wallets: basket `bsv21`, `customInstructions` `{ id, amt, keyID }`,
   `protocolID` `[0, 'onesat']` (legacy `[0, 'p 1sat']`), `counterparty` `'self'`. The SDK's
   `proveHoldings()` does this with `listOutputs` and checks each derived key's hash160 against the
   output's locking script before signing. At most 50 proofs.

The wallet posts back (`AccessResponse`):

```json
{ "v": 1, "challenge": "<the exact string>", "identityKey": "02…", "signature": [48, …],
  "holdings": [{ "pubkey": "03…", "signature": [48, …], "outpoints": ["<txid>_<vout>"] }] }
```

`outpoints` is a hint for the user and logs only. Servers never trust it.

## 3. What the server checks (`verifyAccess`), in order

1. The response and challenge parse, and the challenge is canonical. Otherwise `bad_request`.
2. The nonce is taken from the shared store (read and delete in one step, so it is burned before anything else).
   Missing means `expired` if past `exp`, else `replay`. The stored string must equal the posted one exactly (else `replay`).
3. The origin equals the server's configured origin, and the requirement equals the gate's config.
4. `identityKey` equals `sub` if set (`wrong_account`), and the identity signature verifies (`invalid_signature`).
5. Identity: the resolver returns `{ level, kyc }`, giving `kyc_required` / `identity_level_too_low{have,need}`.
6. Tokens: each holding proof that verifies yields a P2PKH address. Proofs that fail count nothing. The resolver
   sums the confirmed unspent balance over those addresses (1Sat: `POST /bsv21/<id>/p2pkh/balance`).
   `minBps` needs the supply (`GET /bsv21/<id>`, rounded up). Short gives `insufficient_tokens{have,need}` (raw strings).

**Fail closed.** Any resolver error (indexer down, bit-sign down, supply unknown) is
`indexer_unavailable`, never "holds 0" and never a grant.

## 4. Error codes

Wallets return these from their prompt, and sites answer with them as `{ error, message, have?, need? }`.

| Code | HTTP | Who raises it | Meaning |
|------|------|---------------|---------|
| `not_installed` | 424 | site client | No BRC-100 wallet found |
| `user_rejected` | 403 | wallet | User declined |
| `wrong_account` | 409 | wallet / server | Signing identity is not `sub` |
| `insufficient_tokens` | 403 | server (wallet may pre-check) | `have`, `need`: raw integer strings |
| `identity_level_too_low` | 403 | server | `have`, `need`: levels |
| `kyc_required` | 403 | server | No live KYC credential |
| `indexer_unavailable` | 503 | server | Could not confirm; retry |
| `expired` | 401 | wallet / server | Past `exp` |
| `replay` | 401 | server | Nonce already used or unknown |
| `invalid_signature` | 401 | server | Identity signature did not verify |
| `bad_request` | 400 | anyone | Malformed challenge / response / config |

## 5. Session and re-verification

On success the site sets a short-lived HMAC-signed cookie (`createBwalletXAccess`; default 1 day):
`{ sub: identityKey, acc: canonical(require), ad: [proven addresses], iat, exp }`. It is bound to the
identity key and to the exact requirement, so changing the gate invalidates old cookies.

`getAccess()` re-reads the balance over the proven addresses at most every `recheckEvery` seconds
(default 300) per server process. When the user sells or moves the tokens, access ends at the next
re-check (`insufficient_tokens`). If the indexer is down at re-check, access is refused
(`indexer_unavailable`) until it answers.

Tokens moved to a **new** derived key in the same wallet are not in `ad`. The user signs again to
re-prove them. That is a deliberate trade: no server-side address book is needed.

## 6. Wallet UX (bWalletX app and extension team)

- Trigger: a `createSignature` call with `protocolID [2, 'bwalletx access']` whose `data` parses as a v1
  challenge. Parse it and validate it like `parseAccessChallenge`. Refuse if `origin` is not the calling origin.
- **One video per screen, never two.** The prompt opens on the **primary kind's** video (`kind`). Prerequisites
  that are not yet met are separate, sequential steps, each a screen with its own single video, and the
  flow then returns to the primary screen to approve:
  - identity level / KYC short: a **401** (green) step, which goes to bit-sign / Veriff to raise the level
  - tokens short: a **402** (blue) step to buy the shortfall (quote the `need − have`)
  - then back to the **403** (red) screen to approve entry
- A user who already qualifies sees one screen, one video, one tap.
- Show: the site origin, what is asked ("Hold 100 $BOASE"), what you hold, and that nothing is spent.
- On approve: sign the identity signature, then the holding proofs (one approval covers all of them;
  don't prompt per key). On decline: return `user_rejected`. On a different account: `wrong_account`.
- The wallet may pre-check its own balance and offer the 402 step, but the server's indexer is the judge.

## 7. Reference servers

- `oneSatResolver()`: balances and supply from `api.1sat.app` (the same indexer as bit-sign token rooms).
- `bitSignResolver()`: identity level / KYC from bit-sign `POST /api/access/verify`. bit-sign checks the
  identity signature itself and discloses only the facts the signed challenge asked for (the user's
  signature is their consent for that origin). That endpoint is also a full reference verifier for tokens
  (it adds addresses the user has linked on bit-sign).

## 8. Versioning

`v` is bumped for any change to the signed bytes or the checks. Wallets must refuse unknown versions.
The protocol ID `[2, 'bwalletx access']` stays the same across versions.
