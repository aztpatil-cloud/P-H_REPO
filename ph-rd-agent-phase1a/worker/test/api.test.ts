import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApi } from '../src/api/server';
import { bootstrapDatabase } from '../src/bootstrap';
import { runResearch, runStage1 } from '../src/pipeline/engine';
import { GeminiAdapter } from '../src/providers/gemini/adapter';
import { PriceBook } from '../src/pricing';
import { runJobLoop } from '../src/worker-loop';
import { fakeVendor } from './fake-vendor';
import { freshDb, } from './helpers';
import { FOUNDER, engineDeps, pgliteDb, world, type World } from './world';

const ARCH = '00000000-0000-0000-0000-0000000000a1'; const MEMBER = '00000000-0000-0000-0000-0000000000b1'; const OUTSIDER = '00000000-0000-0000-0000-0000000000c1';
const TOKENS: Record<string, { id: string; email: string }> = { tf: { id: FOUNDER, email: 'f@x.com' }, ta: { id: ARCH, email: 'a@x.com' }, tm: { id: MEMBER, email: 'm@x.com' }, to: { id: OUTSIDER, email: 'o@x.com' } };

async function boot(w: World, o: { founderEmail?: string } = {}) {
  await w.raw.exec(`insert into auth.users values ('${ARCH}','a@x.com'),('${MEMBER}','m@x.com'),('${OUTSIDER}','o@x.com');
    insert into profiles(id,email,role) values ('${ARCH}','a@x.com','architect'),('${MEMBER}','m@x.com','member');`);
  const e = engineDeps(w);
  const gemini = () => new GeminiAdapter(new PriceBook([]), { apiKey: 'good-key', fetch: fakeVendor('good-key'), sleep: async () => {} });
  const api = createApi({ db: w.db, store: w.store, engine: e.deps, founderEmail: o.founderEmail, knownProviders: ['gemini'],
    verifyToken: async t => TOKENS[t] ?? null, keys: { 'Gemini API key': true }, publicConfig: { supabaseUrl: 'https://x.supabase.co', anonKey: 'anon' },
    providerFor: gemini, badCredentialProviderFor: () => new GeminiAdapter(new PriceBook([]), { apiKey: 'wrong', fetch: fakeVendor('good-key'), sleep: async () => {} }) });
  const server: Server = createServer((q, r) => { void api(q, r); }); await new Promise<void>(r => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; } return { status: r.status, json };
  };
  return { call, close: () => new Promise<void>(r => server.close(() => r())), e };
}

describe('API: access control', () => {
  it('health and the setup page are public; everything under /api needs a valid login and a profile', async () => {
    const w = await world(); const a = await boot(w);
    expect((await a.call('GET', '/health', null)).json).toEqual({ ok: true });
    const page = await a.call('GET', '/setup', null); expect(page.status).toBe(200); expect(page.json).toContain('<title>');
    expect((await a.call('GET', '/setup/config.json', null)).json).toEqual({ supabaseUrl: 'https://x.supabase.co', anonKey: 'anon' });
    expect((await a.call('GET', '/api/me', null)).status).toBe(401);
    expect((await a.call('GET', '/api/me', 'bogus')).status).toBe(401);
    expect((await a.call('GET', '/api/me', 'to')).status).toBe(403);                         // valid login, no access yet
    expect((await a.call('GET', '/api/me', 'tf')).json).toMatchObject({ role: 'founder' });
    expect((await a.call('GET', '/nope', null)).status).toBe(404); expect((await a.call('PATCH', '/api/me', 'tf')).status).toBe(405);
    await a.close();
  });
  it('roles: members cannot touch setup; the architect can view status and prompts but not change budgets or routes', async () => {
    const w = await world(); const a = await boot(w);
    expect((await a.call('GET', '/api/setup/status', 'tm')).status).toBe(403);
    expect((await a.call('GET', '/api/setup/status', 'ta')).status).toBe(200);
    expect((await a.call('PUT', '/api/setup/settings', 'ta', { monthlyBudgetInr: 1, investigationCapInr: 1, fxRateInrPerUsd: 1 })).status).toBe(403);
    expect((await a.call('PUT', '/api/setup/routes', 'ta', { allTasks: w.modelId })).status).toBe(403);
    expect((await a.call('POST', '/api/setup/models/' + w.modelId + '/data-policy', 'ta', {})).status).toBe(403);
    expect((await a.call('GET', '/api/prompts', 'ta')).status).toBe(200);
    await a.close();
  });
  it('the founder email bootstraps the first founder profile exactly once', async () => {
    const w = await world(); await w.raw.exec(`delete from model_routes; delete from profiles;`);
    const a = await boot(w, { founderEmail: 'F@x.com' }); await w.raw.exec(`delete from profiles where id <> '${FOUNDER}'`);
    await w.raw.exec(`delete from profiles`);
    expect((await a.call('GET', '/api/me', 'tf')).json).toMatchObject({ role: 'founder' });
    expect((await a.call('GET', '/api/me', 'ta')).status).toBe(403);                          // not the founder email, and a founder already exists
    await a.close();
  });
});

describe('API: setup gates, end to end', () => {
  it('budgets validate; a model goes candidate -> priced -> verified -> data policy -> conformance -> active -> routed; each gate is enforced', async () => {
    const w = await world({ routes: false, modelCleared: false, priceVerified: false }); await w.raw.exec(`update model_registry set status='candidate'; update model_prices set verified_at=null`);
    const a = await boot(w); const F = 'tf';
    expect((await a.call('PUT', '/api/setup/settings', F, { monthlyBudgetInr: 100, investigationCapInr: 800, fxRateInrPerUsd: 90 })).status).toBe(422);        // cap above monthly
    expect((await a.call('PUT', '/api/setup/settings', F, { monthlyBudgetInr: 10000, investigationCapInr: 800, testRunCapInr: 500, fxRateInrPerUsd: 90 })).status).toBe(200);
    const st = (await a.call('GET', '/api/setup/status', F)).json; expect(st.ready.budgets).toBe(true); expect(st.ready.routes).toBe(false);
    const m = st.models[0]; expect(m.confidential_ok).toBe(false);
    // gates in order
    expect((await a.call('POST', `/api/setup/models/${m.id}/conformance`, F)).status).toBe(422);                                            // price not verified yet
    await a.call('POST', `/api/setup/prices/${m.prices[0].id}/verify`, F);
    expect((await a.call('POST', `/api/setup/models/${m.id}/activate`, F)).status).toBe(422);                                               // conformance not passed
    const conf = await a.call('POST', `/api/setup/models/${m.id}/conformance`, F); expect(conf.status).toBe(200);
    expect(conf.json.checks.filter((c: any) => !c.passed)).toEqual([]); expect(conf.json.passed).toBe(true);
    expect((await a.call('POST', `/api/setup/models/${m.id}/activate`, F)).status).toBe(200);
    expect((await a.call('POST', `/api/setup/models/${m.id}/data-policy`, F, { trainsOnInputs: 'no', sourceUrl: '', retentionNote: 'x' })).status).toBe(422);   // source required
    expect((await a.call('POST', `/api/setup/models/${m.id}/data-policy`, F, { trainsOnInputs: 'no', sourceUrl: 'https://terms.example', retentionNote: 'kept 30 days for abuse checks' })).status).toBe(200);
    expect((await a.call('PUT', '/api/setup/routes', F, { allTasks: m.id })).status).toBe(200);
    const after = (await a.call('GET', '/api/setup/status', F)).json; expect(after.models[0].confidential_ok).toBe(true); expect(after.ready.routes).toBe(true);
    expect(Number((await w.db.query(`select count(*)::int c from audit_log where action in ('conformance_run','model_activated','routes_changed','settings_changed','data_policy_verified','price_verified')`))[0].c)).toBeGreaterThanOrEqual(6);
    expect(Number((await w.db.query(`select count(*)::int c from cost_ledger where task='conformance'`))[0].c)).toBeGreaterThan(0);        // the check's own cost is on the ledger
    await a.close();
  });
  it('routes: an inactive model or one that cannot serve a task is refused with reasons', async () => {
    const w = await world({ routes: false }); await w.raw.exec(`update model_registry set status='candidate'`); const a = await boot(w);
    expect((await a.call('PUT', '/api/setup/routes', 'tf', { allTasks: w.modelId })).json.error).toMatch(/not active/);
    await w.raw.exec(`update model_registry set status='active', supports_tool_calling=false`);
    expect((await a.call('PUT', '/api/setup/routes', 'tf', { assignments: { stage2_research: w.modelId } })).json.error).toMatch(/needs tool calling/);
    await a.close();
  });
  it('team: founder grants access to an existing login; unknown logins are refused', async () => {
    const w = await world(); const a = await boot(w);
    expect((await a.call('POST', '/api/setup/team', 'tf', { email: 'o@x.com', role: 'member' })).status).toBe(200);
    expect((await a.call('GET', '/api/me', 'to')).json).toMatchObject({ role: 'member' });
    expect((await a.call('POST', '/api/setup/team', 'tf', { email: 'ghost@x.com', role: 'member' })).status).toBe(404);
    await a.close();
  });
});

describe('API: instruction files', () => {
  const labelsDoc = (extra = '') => `---\nkind: evidence_labels\nname: Labels test\n---\nlabels:\n  - {key: established_science, name: E, definition: d, strength: 3}\n  - {key: our_hypothesis, name: H, definition: d, strength: 0, rules: {allow_no_sources: true}}\n${extra}`;
  it('saving validates and reports errors; invalid versions cannot be activated; valid ones can, archiving the old one', async () => {
    const w = await world(); const a = await boot(w);
    const bad = await a.call('POST', '/api/prompts', 'ta', { kind: 'stage1_plan', content: '---\nkind: stage1_plan\nname: x\n---\nno variables' });
    expect(bad.json.ok).toBe(false); expect(bad.json.errors[0].code).toBe('missing_variable');
    expect((await a.call('POST', `/api/prompts/${bad.json.id}/activate`, 'ta')).status).toBe(422);
    const ok = await a.call('POST', '/api/prompts', 'ta', { kind: 'stage1_plan', content: '---\nkind: stage1_plan\nname: Plan v2\nrequires:\n  structured_output: true\n---\nInvestigate {{problem}} using {{available_sources}}' });
    expect(ok.json).toMatchObject({ ok: true, version: 3 });             // the rejected draft kept version 2, so history shows what was tried
    expect((await a.call('POST', `/api/prompts/${ok.json.id}/activate`, 'ta')).status).toBe(200);
    const list = (await a.call('GET', '/api/prompts', 'tf')).json.filter((p: any) => p.kind === 'stage1_plan'); expect(list.map((p: any) => `${p.version}:${p.status}`)).toEqual(['3:active', '2:draft', '1:archived']);
    expect((await a.call('POST', '/api/prompts/' + ok.json.id + '/activate', 'tm')).status).toBe(403);
    await a.close();
  });
  it('a stage prompt that needs more than the routed model offers is refused at activation, not discovered mid-run', async () => {
    const w = await world(); const a = await boot(w);
    const hungry = await a.call('POST', '/api/prompts', 'tf', { kind: 'stage1_plan', content: '---\nkind: stage1_plan\nname: Hungry\nrequires:\n  min_context_tokens: 9000000\n---\n{{problem}}' });
    const r = await a.call('POST', `/api/prompts/${hungry.json.id}/activate`, 'tf'); expect(r.status).toBe(422); expect(r.json.error).toMatch(/context of at least 9000000/);
    await a.close();
  });
  it('a new label file cannot drop a label that saved findings use', async () => {
    const w = await world(); const e = engineDeps(w); const id = await w.store.createInvestigation({ title: 't', problem: 'p', createdBy: FOUNDER });
    await runStage1(e.deps, id); const a = await boot(w);
    await w.raw.exec(`insert into findings(investigation_id,claim,evidence_label,label_set_id,source_type) select '${id}','c','experimental',(select id from prompt_versions where kind='evidence_labels'),'patent'`);
    const v = await a.call('POST', '/api/prompts', 'tf', { kind: 'evidence_labels', content: labelsDoc() }); expect(v.json.ok).toBe(true);
    const r = await a.call('POST', `/api/prompts/${v.json.id}/activate`, 'tf'); expect(r.status).toBe(422); expect(r.json.error).toMatch(/"experimental" is used by saved findings/);
    await a.close();
  });
});

describe('API: running an investigation', () => {
  it('create -> plan -> approve -> research -> read the report, all through the API', async () => {
    const w = await world(); const a = await boot(w);
    expect((await a.call('POST', '/api/investigations', 'tm', { title: '', problem: 'x' })).status).toBe(422);
    const c = await a.call('POST', '/api/investigations', 'tm', { title: 'Shelf life', problem: 'Extend shelf life of a fruit snack.', capInr: 5000 }); expect(c.status).toBe(200);
    const id = c.json.id; expect((await a.call('GET', `/api/investigations/${id}`, 'tm')).json.investigation.capInr).toBe(800);   // cannot raise above the setting
    await runStage1(a.e.deps, id);
    const d1 = (await a.call('GET', `/api/investigations/${id}`, 'tm')).json; expect(d1.investigation.status).toBe('awaiting_approval'); expect(d1.plan.plan.sub_questions).toHaveLength(2); expect(d1.plan.estimate.expectedInr).toBeGreaterThan(0);
    expect((await a.call('POST', `/api/investigations/${id}/stop`, 'tm')).status).toBe(409);
    expect((await a.call('POST', `/api/investigations/${id}/approve`, 'tm', { plan: { ...d1.plan.plan, search_plan: [] } })).status).toBe(422);
    expect((await a.call('POST', `/api/investigations/${id}/approve`, 'tm', {})).status).toBe(200);
    // the job queue has the research job; run it exactly as the worker loop would
    const ctrl = new AbortController();
    await runJobLoop(w.db, { research: p => runResearch(a.e.deps, p.investigationId), stage1: async () => {} }, { workerId: 't', signal: ctrl.signal, once: true, log: () => {} });
    await runJobLoop(w.db, { research: p => runResearch(a.e.deps, p.investigationId), stage1: async () => {} }, { workerId: 't', signal: ctrl.signal, once: true, log: () => {} });
    const d2 = (await a.call('GET', `/api/investigations/${id}`, 'tm')).json;
    expect(d2.investigation.status).toBe('complete'); expect(d2.report.sections).toHaveLength(9); expect(d2.findings.length).toBe(4); expect(d2.sources.map((s: any) => s.handle)).toEqual(['S1', 'S2', 'S3']);
    expect(d2.searchLog.length).toBe(3); expect(d2.report.banner).toMatch(/Limited coverage/);
    const list = (await a.call('GET', '/api/investigations', 'tm')).json; expect(list[0]).toMatchObject({ id, status: 'complete' }); expect(Number(list[0].spent_inr)).toBeGreaterThan(0);
    await a.close();
  });
  it('rejecting a plan ends the investigation before any research or spending on research', async () => {
    const w = await world(); const a = await boot(w); const id = (await a.call('POST', '/api/investigations', 'tm', { title: 't', problem: 'p' })).json.id;
    await runStage1(a.e.deps, id); expect((await a.call('POST', `/api/investigations/${id}/reject`, 'tm')).status).toBe(200);
    const inv = (await a.call('GET', `/api/investigations/${id}`, 'tm')).json.investigation; expect(inv.status).toBe('stopped_user'); expect(inv.coverageNote).toMatch(/plan rejected/);
    expect(a.e.openalex.calls).toEqual([]); await a.close();
  });
  it('creating an investigation is refused with a clear reason until budgets are set', async () => {
    const w = await world({ cap: null }); const a = await boot(w);
    const r = await a.call('POST', '/api/investigations', 'tm', { title: 't', problem: 'p' }); expect(r.status).toBe(422); expect(r.json.error).toMatch(/cap/i); await a.close();
  });
});

describe('database bootstrap and job loop', () => {
  const sql = readFileSync(join(__dirname, '../../supabase/migrations/0001_core.sql'), 'utf8'); const seed = readFileSync(join(__dirname, '../../supabase/seed.sql'), 'utf8');
  const stub = `create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$; create role authenticated; create role anon; create role service_role;`;
  it('a fresh database gets the schema and the seeded instruction files; a second boot changes nothing', async () => {
    const raw = await (await import('@electric-sql/pglite')).PGlite.create(); await raw.exec(stub); const db = pgliteDb(raw as any); const logs: string[] = [];
    const r1 = await bootstrapDatabase(db, { migrations: [{ name: '0001_core.sql', sql }], seedSql: seed }, m => logs.push(m)); expect(r1).toEqual({ applied: ['0001_core.sql'], seeded: true });
    expect(Number((await db.query(`select count(*)::int c from prompt_versions where status='active'`))[0].c)).toBe(4);
    const r2 = await bootstrapDatabase(db, { migrations: [{ name: '0001_core.sql', sql }], seedSql: seed }, () => {}); expect(r2).toEqual({ applied: [], seeded: false });
    const r3 = await bootstrapDatabase(db, { migrations: [{ name: '0001_core.sql', sql }, { name: '0002_x.sql', sql: 'create table public.x_test(a int);' }], seedSql: seed }, () => {}); expect(r3.applied).toEqual(['0002_x.sql']);
  });
  it('a hand-run schema is adopted, not re-applied', async () => {
    const raw = await (await import('@electric-sql/pglite')).PGlite.create(); await raw.exec(stub); await raw.exec(sql); const db = pgliteDb(raw as any);
    expect((await bootstrapDatabase(db, { migrations: [{ name: '0001_core.sql', sql }], seedSql: seed }, () => {})).applied).toEqual([]);
  });
  it('a failing job is retried later and eventually marked failed; unknown kinds fail visibly', async () => {
    const w = await world(); await w.store.enqueue('boom', {}); const ctrl = new AbortController(); const logs: string[] = [];
    for (let i = 0; i < 3; i++) { await w.raw.exec(`update jobs set run_after = now() - interval '1 minute'`); await runJobLoop(w.db, { boom: async () => { throw new Error('kaput'); } }, { workerId: 'x', signal: ctrl.signal, once: true, log: m => logs.push(m) }); }
    const j = (await w.db.query(`select status, attempts, last_error from jobs where kind='boom'`))[0]; expect(j).toMatchObject({ status: 'failed', attempts: 3, last_error: 'kaput' });
  });
});
