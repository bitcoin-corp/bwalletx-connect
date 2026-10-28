// The <script> build: everything in index.ts as window.bWalletXConnect, and <bwalletx-signin> registered.
import { defineBwalletxSignin } from './element.js';
import { defineBwalletxButton } from './wallet-button.js';

export * from './index.js';
defineBwalletxSignin();
defineBwalletxButton();
