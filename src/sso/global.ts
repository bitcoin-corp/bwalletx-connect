/** One <script> tag for static sites: window.bwxSso(...). No @bsv/sdk (the hub talks to the wallet, not the site). */
import { bwxSso } from './browser.js';
export { bwxSso };
export { SIGNIN_EVENT, DEFAULT_HUB } from './shared.js';
