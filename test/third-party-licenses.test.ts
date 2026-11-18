/**
 * The one-script-tag build bundles @bsv/sdk and qrcode-generator; their licence notices must ship with it and match
 * what is installed (and therefore bundled). Run `pnpm licenses` after the lockfile moves either package.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { differences } from '../scripts/third-party-licenses.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[]; dependencies: Record<string, string> };

describe('third-party licences', () => {
  it('the committed notices match the installed @bsv/sdk and qrcode-generator', () => {
    expect(differences()).toEqual([]);
  });

  it('ship in the npm package', () => {
    expect(pkg.files).toContain('THIRD_PARTY_LICENSES.md');
    expect(pkg.files).toContain('third-party');
  });

  it('cover every runtime dependency (all are bundled into the global build)', () => {
    const index = readFileSync(new URL('../THIRD_PARTY_LICENSES.md', import.meta.url), 'utf8');
    for (const dep of Object.keys(pkg.dependencies)) expect(index).toContain(`## ${dep} `);
  });
});
