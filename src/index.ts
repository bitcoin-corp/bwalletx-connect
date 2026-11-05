export { findBwalletX, discoverBwalletX, prewarmBwalletX, bindPrewarm, isFramed, DEFAULT_DISCOVER_MS, BWALLETX_RDNS, RDNS_EXTENSION, RDNS_MOBILE } from './discover.js';
export type { FoundWallet, FoundBy } from './discover.js';
export { pairBwalletX, restorePairing, clearPairing } from './pair.js';
export type { PairingOptions, PairConnectionOptions, PairStorage, PairedWallet, SocketLike, SocketFactory } from './pair.js';
export { signInWithBwalletX, signInAndVerify, connectBwalletX, waitIfLocked, challengeWantsIdentityKey, LOGIN_PROTOCOL } from './signin.js';
export type { Challenge, SignInAndVerifyOptions, SignInOptions, SignInResult, SignInMethod, SignInStage, SignInStatus } from './signin.js';
export { renderButton, LOGO_URL } from './button.js';
export type { ButtonOptions } from './button.js';
export { inOrder } from './in-order.js';
export { defineBwalletxSignin, buildAuthorizeUrl, signinText, markSvg, SIGNIN_TAG, SIGNIN_CSS, MENU_CSS, PENDING_NOTE, PENDING_LABEL, PENDING_LABEL_OTHER, SWITCH_NOTE, CONTINUE_OTHER_LABEL, GET_URL, WEB_WALLET_URL } from './element.js';
export type { SigninSize, SigninTheme, SigninLabel, SigninBrand, SigninState, SigninAccount, SigninMode, AuthorizeParams } from './element.js';
export { accountLabel, avatarUrlFor, lookupPaymail, shortKey, isUserRejection, signInErrorText, rememberedIdentity, rememberIdentity, IDENTITY_HINT_KEY, PAYMAIL_LOOKUP_URL, BAVATAR_URL } from './account.js';
export { defineBwalletxButton, getUrlFor, stateFor, handleLabel, dropLegacyConnectedKey, migrateConnectedKey, BUTTON_TAG, CONNECTED_KEY } from './wallet-button.js';
export type { ButtonState } from './wallet-button.js';
export { pay, tip, buyToken, amountInSats, resolvePaymailP2P, PaymentError, BRC29_PROTOCOL, isPaymail, isIdentityKeyHex } from './pay.js';
export type { PayRequest, PayResult, PayOptions, PayOutput, PaySource, LegacyPayer, Brc29Remittance, BuyTokenRequest, TokenQuote, PaymentErrorCode } from './pay.js';
export { discoverWallets, brc100Option, pairingOption, desktopOption, handcashAdapter, autoChoice, cwiIsAnnounced, DESKTOP_OPTION_ID } from './wallets.js';
export type { WalletOption, ConnectedWallet, WalletKind, Substrate, DiscoverWalletsOptions, HandCashAdapterOptions, ConnectOptions } from './wallets.js';
export { isTouchDevice, pairingModal, pickWallet, chooseWallet, qrSvg } from './modal.js';
export type { PairingModalOptions, ChooseWalletOptions } from './modal.js';
export {
  BWALLETX_TYPE, decideWallet, hasBwalletX, isPresentBwalletX, otherDetected, chooserOrder, walletTypeOf, substrateOf,
  attemptFor, outcomeOf, reportAttempt,
  WALLET_CHOICE_KEY, rememberWalletChoice, rememberedWalletChoice, forgetWalletChoice, isRememberable, isExplicitPick,
  matchRemembered, needsBwalletX, planAutoConnect, attachRemembered,
} from './choice.js';
export type {
  WalletChoice, ChoiceReason, DecideWalletOptions, ConnectAttempt, AttemptOutcome, AttemptHook, RememberedWallet, AutoConnectAction, AutoConnectPlan,
} from './choice.js';
export { requestAccess, proveHoldings, toAccessError, throwIfAccessError } from './access-client.js';
export type { RequestAccessOptions, RequestAccessResult, AccessChallengeLike } from './access-client.js';
export { ACCESS_PROTOCOL, ACCESS_VERSION, AccessError, PROTOCOL_MEDIA, protocolMediaUrl, accessErrorMessage, canonicalJson, ACCESS_ERROR_STATUS } from './access.js';
export type { AccessKind, AccessRequirement, TokenRequirement, AccessChallenge, AccessResponse, HoldingProof, AccessErrorCode, AccessErrorBody } from './access.js';
export { declareWalletTheme, WALLET_THEME_META } from './theme.js';
export { runConnect } from './connect-flow.js';
export type { ConnectFlowOptions, ConnectFlowResult } from './connect-flow.js';
