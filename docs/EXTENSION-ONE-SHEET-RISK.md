# For the bWalletX extension team: first sign-in can still split into two sheets

Found 5 Nov 2026 while tracing vexvoid.com's two "Connect and sign in" sheets (bundle-…-1, then bundle-…-2 about 1 s
later). vexvoid runs @bwalletx/connect 0.5.4, which asks for the key, waits for the approval, then signs: that is the
two sheets, and 0.5.5+ fixes it by sending `getPublicKey({ identityKey: true })` and `createSignature` together.

One risk remains on the extension side (read from origin/bwallet f09d69e3, not yet confirmed in a live run):

- `src/background.ts:3629–3643`: `GET_PUBLIC_KEY` first awaits the reconnect gate (`gateAsk`) and, on the first
  identity-key request of a session, `manifestOnce.run(site, … waitForAuthentication({}, site))`, which fetches the
  site's manifest.json. Only then does `processCWIGetPublicKey` raise the "identity key retrieval" permission.
- `src/background.ts:3661`: `CREATE_SIGNATURE` raises its `bwallet sign in` permission at once.
- `src/services/permissionBundle.ts:120`: the merge window is `DEFAULT_MERGE_WINDOW_MS = 60`.

If the manifest step takes more than 60 ms, the identity line arrives after the bundle closed. It then joins the open
sheet as an unticked "New: …" line (`permissionBundle.ts:165`, `checked = !risky && !r.addedLive` at line 580), or,
when the user has already touched the sheet, queues as a second bundle: two sheets for one sign-in.

Suggested fix (any one): keep a site's bundle collecting while `manifestOnce.run` for that site is in flight; or run
the manifest step before the first protocol permission of a site, whichever call arrives first; or treat a late
identity-key line that pairs with an open sign-in line as part of the same action (pre-ticked, not "New").

How to confirm: a fresh profile, the 0.5.6 package, a site whose manifest.json is slow (add 300 ms), one tap on
Sign in. Expected one sheet; the risk shows as an unticked "New:" line or a second sheet.
