import { describe, expect, it, vi } from 'vitest';
import { memoryStore, type PendingChallenge } from '../src/server';
import { pgNonceTableSql, pgStore, redisStore } from '../src/nonce-stores';

const challenge = (ms = 60_000): PendingChallenge => ({ identityKey: '02' + 'ab'.repeat(32), origin: 'https://a.com', message: 'm', expiresAt: Date.now() + ms });

describe('memoryStore', () => {
  it('is single use', async () => {
    const s = memoryStore({ quiet: true });
    await s.put('n', challenge());
    expect(await s.take('n')).toMatchObject({ message: 'm' });
    expect(await s.take('n')).toBeNull();
  });
});

function fakeRedis() {
  const m = new Map<string, string>();
  const calls: unknown[][] = [];
  return {
    m,
    calls,
    client: {
      async set(k: string, v: string, ...args: unknown[]) {
        calls.push([k, v, ...args]);
        m.set(k, v);
        return 'OK';
      },
      async getdel(k: string) {
        const v = m.get(k) ?? null;
        m.delete(k);
        return v;
      },
    },
  };
}

describe('redisStore', () => {
  it('sets with a TTL and takes once (Upstash / node-redis shape)', async () => {
    const r = fakeRedis();
    const s = redisStore({ client: r.client });
    await s.put('abc', challenge(120_000));
    expect(r.calls[0][0]).toBe('bwalletx:nonce:abc');
    expect(r.calls[0][2]).toEqual({ ex: 120, EX: 120 });
    expect(await s.take('abc')).toMatchObject({ origin: 'https://a.com' });
    expect(await s.take('abc')).toBeNull();
  });

  it('uses positional EX for ioredis', async () => {
    const r = fakeRedis();
    await redisStore({ client: r.client, flavor: 'ioredis', prefix: 'p:' }).put('n', challenge(5_000));
    expect(r.calls[0]).toEqual(['p:n', expect.any(String), 'EX', 5]);
  });

  it('accepts getDel (node-redis) and ignores expired or junk values', async () => {
    const m = new Map<string, unknown>([
      ['bwalletx:nonce:old', JSON.stringify(challenge(-1))],
      ['bwalletx:nonce:junk', '{nope'],
    ]);
    const s = redisStore({ client: { set: async () => 'OK', getDel: async (k: string) => m.get(k) ?? null } });
    expect(await s.take('old')).toBeNull();
    expect(await s.take('junk')).toBeNull();
  });

  it('refuses a client without GETDEL', () => {
    expect(() => redisStore({ client: { set: async () => 'OK' } })).toThrow(/getdel/);
  });
});

describe('pgStore', () => {
  function fakePg() {
    const rows = new Map<string, { challenge: unknown; expires: number }>();
    const sql: string[] = [];
    const query = vi.fn(async (q: string, p: unknown[]) => {
      sql.push(q);
      if (q.startsWith('delete from bwalletx_nonces where expires_at')) {
        for (const [k, v] of rows) if (v.expires < Date.now()) rows.delete(k);
        return { rows: [] };
      }
      if (q.startsWith('insert')) {
        rows.set(p[0] as string, { challenge: JSON.parse(p[1] as string), expires: p[2] as number });
        return { rows: [] };
      }
      if (q.startsWith('delete from bwalletx_nonces where nonce')) {
        const r = rows.get(p[0] as string);
        rows.delete(p[0] as string);
        return { rows: r ? [{ challenge: r.challenge }] : [] };
      }
      throw new Error('unexpected sql ' + q);
    });
    return { query, sql, rows };
  }

  it('inserts and takes once with DELETE ... RETURNING', async () => {
    const pg = fakePg();
    const s = pgStore({ query: pg.query });
    await s.put('n1', challenge());
    expect(pg.rows.size).toBe(1);
    expect(await s.take('n1')).toMatchObject({ message: 'm' });
    expect(await s.take('n1')).toBeNull();
    expect(pg.sql.some((q) => /returning challenge/.test(q))).toBe(true);
  });

  it('accepts a bare-array query result (postgres.js)', async () => {
    const s = pgStore({ query: async (q) => (q.includes('returning') ? [{ challenge: challenge() }] : []) });
    expect(await s.take('x')).toMatchObject({ message: 'm' });
  });

  it('rejects unsafe table names', () => {
    expect(() => pgStore({ query: async () => [], table: 'bad name;' })).toThrow(/table/);
    expect(pgNonceTableSql('auth.bwalletx_nonces')).toMatch(/create table if not exists auth\.bwalletx_nonces/);
  });
});
