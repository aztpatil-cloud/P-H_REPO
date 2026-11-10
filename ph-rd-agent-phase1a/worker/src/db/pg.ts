import pg from 'pg';
import type { Db, Sql } from './sql';

export function createPgDb(connectionString: string): Db & { close(): Promise<void> } {
  // Supabase requires TLS; its pooler certificate chain is not in Node's default store, so verify=false on the
  // pooler hop only. The connection string is a secret and travels only worker -> Supabase.
  const pool = new pg.Pool({ connectionString, max: 5, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
  const wrap = (c: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Sql => ({ query: async (t, p) => (await c.query(t, p)).rows, exec: async t => { await c.query(t); } });
  return {
    query: async (t, p) => (await pool.query(t, p as any[])).rows,
    exec: async t => { await pool.query(t); },
    async tx(fn) {
      const client = await pool.connect();
      try { await client.query('begin'); const r = await fn(wrap(client)); await client.query('commit'); return r; }
      catch (e) { await client.query('rollback'); throw e; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
