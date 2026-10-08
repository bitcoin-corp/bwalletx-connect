# Sign in with bWalletX: brand guidelines

The standard button is the gold one from bit-sign's sign-in card. Use `<bwalletx-signin>` (or the React wrapper) and you get it right by default. These rules are for when you place it, size it, or draw your own.

## Variants and where to use them

| Variant | Use it for |
|---|---|
| `theme="gold"` (default) | The main way in. Sign-in pages, the first button in a list of sign-in options. |
| `theme="dark"` | Dark UIs where gold would compete with your own primary button, or a secondary row of sign-in options. |
| `theme="light"` | Light pages, and lists of outlined "Continue with …" buttons beside Google, Apple and so on. |
| `size="lg"` (default) | Sign-in cards and landing pages. Shows the subtitle. |
| `size="md"` | Dialogs and narrow cards. Shows the subtitle. |
| `size="sm"` | Navigation bars and toolbars. No subtitle. |
| `size="icon"` | Only where space is very tight and the context already says "sign in" (a row of provider icons). Always keep the aria-label. |
| `label="signin"` / `"continue"` / `"connect"` | "Sign in with" on sign-in pages, "Continue with" in mixed provider lists and onboarding, "Connect" when the user is already signed in and is linking a wallet. |
| `brand="bWallet"` | Store builds and pages shown inside the App Store / Play edition. Drops the subtitle. |

## Do

- Keep the black circle with the gold "b" on the left of the text.
- Keep the text exactly as given ("Sign in with bWalletX", "Continue with bWalletX", "Connect bWalletX"). Translations are fine.
- Give the gold button the most prominent position when bWalletX is your main sign-in.
- Keep the subtitle "also works with bWallet" on lg and md, so store users know the button is for them.
- Make it the same height as the other sign-in buttons next to it.

## Don't

- Don't recolour the gold, change the gradient direction, or put the mark on a coloured circle.
- Don't stretch, rotate, outline or add effects to the mark.
- Don't use the "b" mark alone as a generic Bitcoin or wallet icon.
- Don't write "BWalletX", "bwalletx", "B Wallet X" or "bWallet X" in the button.
- Don't make the bWalletX button smaller or less visible than other providers' buttons in the same list.
- Don't imply that bWalletX endorses your product.

## Minimum sizes

| | Minimum |
|---|---|
| Button height | 36px (`sm`). 48px or more on touch screens (`md`, `lg`, `icon`). |
| Icon-only button | 40px across. 48px recommended. |
| Mark on its own | 16px tall on screen, 6mm in print. |
| Label text | 13px. Subtitle 10.5px, and only on `md` and `lg`. |

## Clear space

Leave space around the button equal to half its height (at least 8px) free of other text and logos. Around the mark on its own, leave the width of the mark's bowl (about a third of the mark's height).

## Colours

| Token | Value |
|---|---|
| Gold gradient top / bottom | `#fcd34d` → `#f59e0b` (hover `#fde68a` → `#fbbf24`) |
| Mark gradient | `#FFE58A` → `#FFD24D` (55%) → `#C98F00` |
| Mark circle | `#000000` |
| Label on gold | `#000000`, subtitle `rgba(0,0,0,.65)` |
| Corner radius | 12px (lg), 10px (md), 8px (sm), round (icon) |
| Shadow (gold) | `0 10px 15px -3px rgba(245,158,11,.2), 0 4px 6px -4px rgba(245,158,11,.2)` |

Black on the gold gradient is above 9:1, and the subtitle stays above 4.5:1 (WCAG AA) at every point of the gradient.

## Files

`assets/` has the mark (`bwalletx-mark.svg`, `bwalletx-mark-circle.svg`), full buttons (`signin-gold.svg`, `signin-dark.svg`, `signin-light.svg`) and a no-JavaScript HTML/CSS version (`snippet.html`).

## Trademarks

The code in this package is MIT. The names bWalletX and bWallet, and the "b" mark, are not covered by that licence. See [TRADEMARKS.md](./TRADEMARKS.md).
