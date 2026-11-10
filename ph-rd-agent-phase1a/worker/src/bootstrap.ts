import type { Db } from './db/sql';

export interface Scripts { migrations: Array<{ name: string; sql: string }>; seedSql: string }

/** First boot: creates the schema and seeds the prompt files. Later boots: applies only migrations not yet recorded. */
export async function bootstrapDatabase(db: Db, s: Scripts, log: (m: string) => void = console.log): Promise<{ applied: string[]; seeded: boolean }> {
  await db.exec(`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query(`select name from public.schema_migrations`)).map((r: any) => r.name));
  const schemaExists = !!(await db.query(`select to_regclass('public.settings') as t`))[0]?.t;
  if (schemaExists && done.size === 0 && s.migrations[0]) { await db.query(`insert into public.schema_migrations(name) values ($1)`, [s.migrations[0].name]); done.add(s.migrations[0].name); }   // adopt a hand-run schema
  const applied: string[] = [];
  for (const m of s.migrations) {
    if (done.has(m.name)) continue;
    await db.tx(async q => { await q.exec(m.sql); await q.query(`insert into public.schema_migrations(name) values ($1)`, [m.name]); });
    applied.push(m.name); log(`applied migration ${m.name}`);
  }
  let seeded = false;
  if (!(await db.query(`select 1 from public.prompt_versions limit 1`)).length) { await db.tx(q => q.exec(s.seedSql)); seeded = true; log('seeded the instruction files'); }
  return { applied, seeded };
}
