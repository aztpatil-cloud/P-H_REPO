import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal stand-ins for Supabase's auth schema so the real migration runs unchanged.
const AUTH_STUB = `
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  -- mirrors Supabase's auth.uid(): reads the JWT subject from request settings
  create function auth.uid() returns uuid language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                       (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  create role authenticated; create role anon; create role service_role;
  grant usage on schema public, auth to authenticated, anon;
`;

export async function freshDb() {
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  const sql = readFileSync(join(__dirname, '../../supabase/migrations/0001_core.sql'), 'utf8');
  await db.exec(sql);
  return db;
}
