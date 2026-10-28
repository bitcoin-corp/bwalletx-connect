// `import '@bwalletx/connect/element'` registers <bwalletx-signin> and <bwalletx-button> as a side effect.
import { defineBwalletxSignin } from './element.js';
import { defineBwalletxButton } from './wallet-button.js';

export * from './element.js';
export * from './wallet-button.js';
defineBwalletxSignin();
defineBwalletxButton();
