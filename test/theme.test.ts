// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { declareWalletTheme, WALLET_THEME_META } from '../src/theme';
import { atStage } from '../src/signin';

const meta = () => document.head.querySelector<HTMLMetaElement>(`meta[name="${WALLET_THEME_META}"]`);

describe('declareWalletTheme', () => {
  it('writes, updates and withdraws one meta tag', () => {
    declareWalletTheme('NPGX');
    expect(meta()?.content).toBe('npgx');
    declareWalletTheme('pink');
    expect(document.head.querySelectorAll(`meta[name="${WALLET_THEME_META}"]`).length).toBe(1);
    expect(meta()?.content).toBe('pink');
    declareWalletTheme(null);
    expect(meta()).toBeNull();
  });

  it('never declares anything but a bare id', () => {
    declareWalletTheme('url(https://x)');
    expect(meta()).toBeNull();
  });
});

describe('atStage', () => {
  it('tags the failing stage and keeps the message', async () => {
    const e = await atStage('challenge', () => Promise.reject(new Error('Missing env var'))).catch((x) => x);
    expect(e.message).toBe('Missing env var');
    expect(e.stage).toBe('challenge');
  });
});
