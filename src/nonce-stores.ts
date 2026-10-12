/**
 * Shared NonceStore adapters. No database driver is imported: you pass your own client or query
 * function. Every adapter makes `take` read-and-delete in one step, so each nonce works once.
 */
import type { NonceStore, PendingChallenge } from './server.js';

const ttlSeconds = (c: PendingChallenge) => Math.max(1, Math.ceil((c.expiresAt - Date.now()) / 1000));

function parse(v: unknown): PendingChallenge | null {
  if (v == null) return null;
  try {
    const c = (typeof v === 'string' ? JSON.parse(v) : v) as PendingChallenge;
    if (!c || typeof c.identityKey !== 'string' || typeof c.message !== 'string' || typeof c.expiresAt !== 'number') return null;
    return c.expiresAt < Date.now() ? null : c;
  } catch {
    return null;
  }
}

/**
 * The Redis commands used. Fits @upstash/redis and node-redis v4+ as they are
 * (`set(key, value, { ex | EX })`, `getdel` / `getDel`). For ioredis pass `flavor: 'ioredis'`.
 */
export interface RedisLike {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  getdel?(key: string): Promise<unknown>;
  getDel?(key: string): Promise<unknown>;
}

export interface RedisStoreOptions {
  client: RedisLike;
  /** Key prefix. Default 'bwalletx:nonce:'. */
  prefix?: string;
  /** 'ioredis' uses positional `set(key, value, 'EX', s)`. Default 'object' (Upstash, node-redis). */
  flavor?: 'object' | 'ioredis';
}

/** Redis / Upstash / Vercel KV. Needs Redis 6.2+ for GETDEL. */
export function redisStore(opts: RedisStoreOptions): NonceStore {
  const { client } = opts;
  const prefix = opts.prefix ?? 'bwalletx:nonce:';
  const getdel = client.getdel?.bind(client) ?? client.getDel?.bind(client);
  if (!getdel) throw new Error('redisStore: the client needs getdel (or getDel). Redis 6.2+.');
  return {
    async put(nonce, c) {
      const s = ttlSeconds(c);
      if (opts.flavor === 'ioredis') await client.set(prefix + nonce, JSON.stringify(c), 'EX', s);
      else await client.set(prefix + nonce, JSON.stringify(c), { ex: s, EX: s });
    },
    async take(nonce) {
      return parse(await getdel(prefix + nonce));
    },
  };
}

/** `query(sql, params)` resolving to `{ rows }` (node-postgres, @vercel/postgres, Neon) or a bare array (postgres.js `sql.unsafe`). */
export type PgQuery = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] } | unknown[]>;

export interface PgStoreOptions {
  query: PgQuery;
  /** Table name (letters, digits, _ and one optional schema dot). Default 'bwalletx_nonces'. */
  table?: string;
}

/** Run this once (a migration) before using pgStore. */
export function pgNonceTableSql(table = 'bwalletx_nonces'): string {
  const t = safeTable(table);
  return `create table if not exists ${t} (
  nonce text primary key,
  challenge jsonb not null,
  expires_at timestamptz not null
);
create index if not exists ${t.replace('.', '_')}_expires_idx on ${t} (expires_at);`;
}

function safeTable(t: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(t)) throw new Error(`pgStore: bad table name ${t}`);
  return t;
}

/** Postgres (e.g. self-hosted Supabase). Single-use via DELETE ... RETURNING. */
export function pgStore(opts: PgStoreOptions): NonceStore {
  const t = safeTable(opts.table ?? 'bwalletx_nonces');
  const rows = (r: { rows: unknown[] } | unknown[]) => (Array.isArray(r) ? r : r.rows);
  return {
    async put(nonce, c) {
      await opts.query(`delete from ${t} where expires_at < now()`, []);
      await opts.query(`insert into ${t} (nonce, challenge, expires_at) values ($1, $2, to_timestamp($3 / 1000.0))`, [
        nonce,
        JSON.stringify(c),
        c.expiresAt,
      ]);
    },
    async take(nonce) {
      const r = rows(await opts.query(`delete from ${t} where nonce = $1 returning challenge`, [nonce]));
      const row = r[0] as { challenge?: unknown } | undefined;
      return parse(row?.challenge);
    },
  };
}
