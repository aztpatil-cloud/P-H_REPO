/** The only database surface the pipeline sees. Production wires `pg`; tests wire PGlite, so the real SQL is exercised. */
export interface Sql { query<T = any>(text: string, params?: unknown[]): Promise<T[]>; /** run a multi-statement script (no parameters) */ exec(text: string): Promise<void> }
export interface Db extends Sql { tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> }

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Runs fn in a transaction as an authenticated user, so database functions that call auth.uid() see them. */
export async function asUser<T>(db: Db, userId: string, fn: (q: Sql) => Promise<T>): Promise<T> {
  return db.tx(async q => { await q.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]); return fn(q); });
}
