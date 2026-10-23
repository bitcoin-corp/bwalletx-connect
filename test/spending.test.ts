import { describe, expect, it, vi } from 'vitest';
import {
  requestSpendingAuthorization,
  revokeSpendingAuthorization,
  STREAM_PROTOCOL,
  supportsSpendingAuthorization,
} from '../src/spending.js';

const wallet = (answer: object) => ({
  requestSpendingAuthorization: vi.fn(async (_a: unknown) => answer as { granted: boolean }),
  revokeSpendingAuthorization: vi.fn(async () => ({ revoked: true })),
});

describe('spending authorization', () => {
  it('feature-detects', () => {
    expect(supportsSpendingAuthorization(wallet({}))).toBe(true);
    expect(supportsSpendingAuthorization({} as never)).toBe(false);
    expect(supportsSpendingAuthorization(undefined)).toBe(false);
  });
  it('resolves with the grant and never sends an originator', async () => {
    const w = wallet({ granted: true, grantId: 'sg_1', capSatsPerHour: 500, expiry: 99 });
    const g = await requestSpendingAuthorization({ protocolID: STREAM_PROTOCOL, capSatsPerHour: 1000, expiry: 99 }, w);
    expect(g).toEqual({ grantId: 'sg_1', protocolID: STREAM_PROTOCOL, capSatsPerHour: 500, expiry: 99 });
    expect(Object.keys(w.requestSpendingAuthorization.mock.calls[0][0] as object)).not.toContain('originator');
  });
  it('rejects on decline, unsupported, and wallet errors', async () => {
    await expect(requestSpendingAuthorization({ protocolID: STREAM_PROTOCOL, capSatsPerHour: 1 }, wallet({ granted: false }))).rejects.toMatchObject({ code: 'DECLINED' });
    await expect(requestSpendingAuthorization({ protocolID: STREAM_PROTOCOL, capSatsPerHour: 1 }, {} as never)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    const bad = { requestSpendingAuthorization: async () => { throw new Error('locked'); }, revokeSpendingAuthorization: async () => 0 };
    await expect(requestSpendingAuthorization({ protocolID: STREAM_PROTOCOL, capSatsPerHour: 1 }, bad)).rejects.toMatchObject({ code: 'WALLET_ERROR' });
  });
  it('revokes', async () => {
    const w = wallet({});
    await revokeSpendingAuthorization('sg_1', w);
    expect(w.revokeSpendingAuthorization).toHaveBeenCalledWith('sg_1');
  });
});
