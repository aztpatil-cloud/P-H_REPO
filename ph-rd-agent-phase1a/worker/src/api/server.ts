import type { IncomingMessage, ServerResponse } from 'node:http';
import { BudgetGovernor, resolveBudgetConfig } from '../budget';
import { asUser, num, type Db } from '../db/sql';
import { PriceBook } from '../pricing';
import { approvePlan, type EngineDeps } from '../pipeline/engine';
import { REPORT_REQUIRES } from '../pipeline/context';
import { MeteredProvider } from '../pipeline/metered';
import type { PgStore } from '../pipeline/store';
import { checkLabelContinuity, mergeRequires, parsePromptFile, PLATFORM_MINIMUMS, PROMPT_KINDS, unmetRequirements, type PromptKind, type Requires } from '../prompts/parse';
import { runConformance, CONFORMANCE_VERSION } from '../providers/conformance';
import type { ModelProvider } from '../providers/types';
import { setupPageHtml } from './setup-page';

export interface ApiDeps {
  db: Db; store: PgStore; engine: EngineDeps;
  verifyToken(token: string): Promise<{ id: string; email: string } | null>;
  founderEmail?: string;
  keys: Record<string, boolean>;
  publicConfig: { supabaseUrl: string; anonKey: string };
  knownProviders: string[];
  providerFor(key: string): ModelProvider;
  badCredentialProviderFor?(key: string): ModelProvider;
}
interface User { id: string; email: string; role: 'founder' | 'architect' | 'member' }
class HttpError extends Error { constructor(readonly status: number, message: string, readonly extra?: unknown) { super(message); } }
const TASKS = ['stage1_plan', 'stage2_research', 'extraction', 'report', 'verification_helper', 'embeddings'];

export function createApi(d: ApiDeps) {
  const cache = new Map<string, { at: number; user: User }>();

  async function authenticate(req: IncomingMessage): Promise<User> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]; if (!token) throw new HttpError(401, 'login required');
    const hit = cache.get(token); if (hit && Date.now() - hit.at < 30_000) return hit.user;
    const who = await d.verifyToken(token); if (!who) throw new HttpError(401, 'invalid or expired login');
    let [p] = await d.db.query(`select id, email, role from public.profiles where id = $1`, [who.id]);
    if (!p && d.founderEmail && who.email.toLowerCase() === d.founderEmail.toLowerCase() && !(await d.db.query(`select 1 from public.profiles where role = 'founder' limit 1`)).length) {
      [p] = await d.db.query(`insert into public.profiles(id, email, role) values ($1,$2,'founder') returning id, email, role`, [who.id, who.email]);   // one-time bootstrap
    }
    if (!p) throw new HttpError(403, 'your account has no access yet; ask the founder to add you');
    const user: User = { id: p.id, email: p.email ?? who.email, role: p.role }; cache.set(token, { at: Date.now(), user }); return user;
  }
  const need = (u: User, ...roles: User['role'][]) => { if (!roles.includes(u.role)) throw new HttpError(403, `requires ${roles.join(' or ')}`); };
  const audit = (u: User, action: string, detail: unknown) => d.db.query(`insert into public.audit_log(actor, action, detail) values ($1,$2,$3::jsonb)`, [u.id, action, JSON.stringify(detail)]);
  const str = (v: unknown, name: string, max = 20_000) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(422, `${name} is required`); return v.trim(); };
  const pos = (v: unknown, name: string) => { if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v)) throw new HttpError(422, `${name} must be a number above 0`); return v; };

  async function activeParsed(): Promise<Record<string, any>> {
    return Object.fromEntries((await d.db.query(`select kind, parsed from public.prompt_versions where status = 'active'`)).map((r: any) => [r.kind, r.parsed]));
  }
  async function modelRows() { return d.db.query(`select m.*, public.model_confidential_ok(m.id) as confidential_ok from public.model_registry m order by m.created_at`); }
  async function refFor(id: string) {
    const [m] = await d.db.query(`select * from public.model_registry where id = $1`, [id]); if (!m) throw new HttpError(404, 'unknown model');
    return { m, ref: { registryId: m.id, provider: m.provider, providerModel: m.provider_model, capabilities: { contextTokens: m.context_tokens, maxOutputTokens: m.max_output_tokens, structuredOutput: m.supports_structured_output, toolCalling: m.supports_tool_calling, embeddings: m.supports_embeddings, reasoningBilledAsOutput: m.reasoning_billed_as_output } } };
  }
  function taskRequires(task: string, prompts: Record<string, any>): Requires {
    if (task === 'stage1_plan') return mergeRequires(PLATFORM_MINIMUMS.stage1_plan, prompts.stage1_plan?.requires ?? {});
    if (task === 'stage2_research') return mergeRequires(PLATFORM_MINIMUMS.stage2_research, prompts.stage2_research?.requires ?? {});
    if (task === 'report') return REPORT_REQUIRES;
    return {};
  }

  const routes: Array<[string, RegExp, (u: User, m: RegExpExecArray, body: any) => Promise<unknown>]> = [];
  const on = (method: string, path: string, h: (u: User, m: RegExpExecArray, body: any) => Promise<unknown>) => routes.push([method, new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), h]);

  on('GET', '/api/me', async u => u);

  // ── setup & operations (founder) ───────────────────────────────────────────
  on('GET', '/api/setup/status', async u => {
    need(u, 'founder', 'architect');
    const settings = (await d.db.query(`select * from public.settings where id = 1`))[0];
    const models = await modelRows(); const prices = await d.db.query(`select * from public.model_prices order by effective_from desc`);
    const routesRows = await d.db.query(`select * from public.model_routes order by task`);
    const prompts = await d.db.query(`select id, kind, version, name, status, activated_at from public.prompt_versions order by kind, version desc`);
    return { keys: d.keys, settings, models: models.map((m: any) => ({ ...m, prices: prices.filter((p: any) => p.model_registry_id === m.id) })), routes: routesRows, prompts, knownProviders: d.knownProviders,
      ready: { budgets: settings.investigation_cap_inr != null && settings.monthly_budget_inr != null && settings.fx_rate_inr_per_usd != null, routes: TASKS.slice(0, 4).filter(t => t !== 'extraction').every(t => routesRows.some((r: any) => r.task === t)) } };
  });
  on('PUT', '/api/setup/settings', async (u, _m, b) => {
    need(u, 'founder');
    const monthly = pos(b.monthlyBudgetInr, 'monthly budget'), cap = pos(b.investigationCapInr, 'investigation cap'), fx = pos(b.fxRateInrPerUsd, 'exchange rate');
    const test = b.testRunCapInr == null ? null : pos(b.testRunCapInr, 'test-run cap');
    if (cap > monthly) throw new HttpError(422, 'the per-investigation cap cannot exceed the monthly budget');
    await d.db.query(`update public.settings set monthly_budget_inr=$1, investigation_cap_inr=$2, test_run_cap_inr=$3, fx_rate_inr_per_usd=$4, updated_at=now() where id=1`, [monthly, cap, test, fx]);
    await audit(u, 'settings_changed', { monthly, cap, test, fx }); return { ok: true };
  });
  on('GET', '/api/setup/available-models', async (u, _m, _b) => {
    need(u, 'founder'); const out: Record<string, unknown> = {};
    for (const key of d.knownProviders) { try { const p = d.providerFor(key); out[key] = p.listModels ? await p.listModels() : []; } catch (e) { out[key] = { error: (e as Error).message }; } }
    return out;
  });
  on('POST', '/api/setup/models', async (u, _m, b) => {
    need(u, 'founder'); if (!d.knownProviders.includes(b.provider)) throw new HttpError(422, 'unknown provider');
    const [m] = await d.db.query(`insert into public.model_registry(provider, provider_model, display_name, context_tokens, max_output_tokens, supports_structured_output, supports_tool_calling, supports_embeddings)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (provider, provider_model) do update set display_name = excluded.display_name returning id`,
      [b.provider, str(b.providerModel, 'model'), str(b.displayName, 'display name'), Math.floor(pos(b.contextTokens, 'context')), Math.floor(pos(b.maxOutputTokens, 'max output')), !!b.supportsStructuredOutput, !!b.supportsToolCalling, !!b.supportsEmbeddings]);
    await audit(u, 'model_added', { id: m.id, provider: b.provider, model: b.providerModel }); return { id: m.id };
  });
  on('POST', '/api/setup/models/:id/prices', async (u, m, b) => {
    need(u, 'founder'); await refFor(m.groups!.id!);
    const [p] = await d.db.query(`insert into public.model_prices(model_registry_id, input_usd_per_m, output_usd_per_m, cached_input_usd_per_m, effective_from, source_note) values ($1,$2,$3,$4,$5,$6) returning id`,
      [m.groups!.id, num(pos(b.inputUsdPerM, 'input price')), num(pos(b.outputUsdPerM, 'output price')), b.cachedInputUsdPerM == null ? null : pos(b.cachedInputUsdPerM, 'cached price'), str(b.effectiveFrom, 'effective date', 10), b.sourceNote ?? null]);
    return { id: p.id };
  });
  on('POST', '/api/setup/prices/:id/verify', async (u, m) => { need(u, 'founder'); await asUser(d.db, u.id, q => q.query(`select public.verify_model_price($1)`, [m.groups!.id])); return { ok: true }; });
  on('POST', '/api/setup/models/:id/data-policy', async (u, m, b) => {
    need(u, 'founder');
    await asUser(d.db, u.id, q => q.query(`select public.verify_model_data_policy($1,$2,$3,$4,$5)`, [m.groups!.id, String(b.trainsOnInputs), String(b.sourceUrl ?? ''), String(b.retentionNote ?? ''), b.region ?? null])).catch(e => { throw new HttpError(422, (e as Error).message); });
    return { ok: true };
  });
  on('POST', '/api/setup/models/:id/conformance', async (u, m) => {
    need(u, 'founder'); const { m: row, ref } = await refFor(m.groups!.id!);
    const settings = await d.store.settings(); if (settings.fxRateInrPerUsd == null) throw new HttpError(422, 'set the exchange rate first');
    let cfg; try { cfg = resolveBudgetConfig(settings, { requestedCapInr: 50 }); } catch (e) { throw new HttpError(422, (e as Error).message); }
    const priceBook = new PriceBook(await d.store.priceRows(), { requireVerified: true });
    try { priceBook.get(ref, new Date()); } catch (e) { throw new HttpError(422, `verify this model's price first: ${(e as Error).message}`); }
    const governor = new BudgetGovernor(cfg, d.store.ledger(null));
    const base = d.providerFor(row.provider);
    const metered = new MeteredProvider(base as any, { governor, sink: d.store, priceBook, fxRate: settings.fxRateInrPerUsd, task: 'conformance', investigationId: null, runStageId: null, isTest: false });
    const report = await runConformance(metered, ref, { badCredentialProvider: d.badCredentialProviderFor ? () => d.badCredentialProviderFor!(row.provider) : undefined }).catch(e => { throw new HttpError(422, (e as Error).message); });
    await d.db.query(`update public.model_registry set conformance_version = $2, conformance_passed_at = case when $3 then now() else null end where id = $1`, [row.id, CONFORMANCE_VERSION, report.passed]);
    await audit(u, 'conformance_run', { model: row.id, passed: report.passed, calls: report.modelCalls }); return report;
  });
  on('POST', '/api/setup/models/:id/activate', async (u, m) => {
    need(u, 'founder'); const { m: row } = await refFor(m.groups!.id!);
    const problems: string[] = []; if (!row.conformance_passed_at) problems.push('the conformance check has not passed');
    const prices = (await d.store.priceRows()).filter(p => p.modelRegistryId === row.id && p.effectiveFrom <= new Date().toISOString().slice(0, 10) && p.verifiedAt);
    if (!prices.length) problems.push('no verified price is in effect today');
    if (problems.length) throw new HttpError(422, `cannot activate: ${problems.join('; ')}`);
    await d.db.query(`update public.model_registry set status = 'active' where id = $1`, [row.id]); await audit(u, 'model_activated', { model: row.id }); return { ok: true };
  });
  on('PUT', '/api/setup/routes', async (u, _m, b) => {
    need(u, 'founder'); const prompts = await activeParsed();
    const assign: Record<string, string> = b.allTasks ? Object.fromEntries(TASKS.filter(t => t !== 'embeddings').map(t => [t, b.allTasks])) : b.assignments ?? {};   // embeddings need a different kind of model (Phase 1b)
    const problems: string[] = [];
    for (const [task, modelId] of Object.entries(assign)) {
      if (!TASKS.includes(task)) { problems.push(`unknown task ${task}`); continue; }
      const { m, ref } = await refFor(String(modelId)); if (m.status !== 'active') problems.push(`${m.display_name} is not active (${task})`);
      const un = unmetRequirements(taskRequires(task, prompts), ref.capabilities); if (un.length) problems.push(`${m.display_name} cannot serve ${task}: ${un.join(', ')}`);
      if (task === 'embeddings' && !m.supports_embeddings) problems.push(`${m.display_name} has no embeddings`);
    }
    if (problems.length) throw new HttpError(422, problems.join('; '), problems);
    for (const [task, modelId] of Object.entries(assign)) await d.db.query(`insert into public.model_routes(task, primary_model_id, updated_by, updated_at) values ($1,$2,$3,now()) on conflict (task) do update set primary_model_id = excluded.primary_model_id, updated_by = excluded.updated_by, updated_at = now()`, [task, modelId, u.id]);
    await audit(u, 'routes_changed', assign); return { ok: true };
  });
  on('POST', '/api/setup/team', async (u, _m, b) => {
    need(u, 'founder'); const email = str(b.email, 'email').toLowerCase(); if (!['founder', 'architect', 'member'].includes(b.role)) throw new HttpError(422, 'role must be founder, architect or member');
    const [a] = await d.db.query(`select id from auth.users where lower(email) = $1`, [email]); if (!a) throw new HttpError(404, 'no such login: create the user in Supabase first');
    await d.db.query(`insert into public.profiles(id, email, role) values ($1,$2,$3) on conflict (id) do update set role = excluded.role`, [a.id, email, b.role]); await audit(u, 'team_changed', { email, role: b.role }); return { ok: true };
  });
  on('GET', '/api/setup/team', async u => { need(u, 'founder'); return d.db.query(`select id, email, role, created_at from public.profiles order by created_at`); });

  // ── prompt files ───────────────────────────────────────────────────────────
  on('GET', '/api/prompts', async u => { need(u, 'founder', 'architect'); return d.db.query(`select id, kind, version, name, status, validation_errors, activated_at, created_at from public.prompt_versions order by kind, version desc`); });
  on('GET', '/api/prompts/:id', async (u, m) => { need(u, 'founder', 'architect'); const [r] = await d.db.query(`select * from public.prompt_versions where id = $1`, [m.groups!.id]); if (!r) throw new HttpError(404, 'unknown version'); return r; });
  on('POST', '/api/prompts', async (u, _m, b) => {
    need(u, 'founder', 'architect'); if (!PROMPT_KINDS.includes(b.kind)) throw new HttpError(422, 'unknown kind'); const content = str(b.content, 'content', 200_000);
    const r = parsePromptFile(content, b.kind as PromptKind);
    const [row] = await d.db.query(`insert into public.prompt_versions(kind, version, name, schema_version, content, parsed, validation_errors, notes, author) values ($1,0,$2,1,$3,$4::jsonb,$5::jsonb,$6,$7) returning id, version`,
      [b.kind, r.parsed?.name || 'unnamed', content, r.parsed ? JSON.stringify(r.parsed) : null, JSON.stringify(r.errors), r.parsed?.notes ?? null, u.id]);
    if (r.ok && b.kind === 'evidence_labels') for (const l of r.parsed!.labels!) await d.db.query(`insert into public.evidence_labels(prompt_version_id, key, name, definition, criteria) values ($1,$2,$3,$4,$5)`, [row.id, l.key, l.name, l.definition, l.criteria ?? null]);
    return { id: row.id, version: row.version, ok: r.ok, errors: r.errors, warnings: r.warnings };
  });
  on('POST', '/api/prompts/:id/activate', async (u, m) => {
    need(u, 'founder', 'architect'); const [v] = await d.db.query(`select * from public.prompt_versions where id = $1`, [m.groups!.id]); if (!v) throw new HttpError(404, 'unknown version');
    if (!v.parsed || !Array.isArray(v.validation_errors) || v.validation_errors.length) throw new HttpError(422, 'this version has validation errors');
    const problems: string[] = [];
    if (v.kind === 'stage1_plan' || v.kind === 'stage2_research') {
      const task = v.kind === 'stage1_plan' ? 'stage1_plan' : 'stage2_research'; const [route] = await d.db.query(`select primary_model_id from public.model_routes where task = $1`, [task]);
      if (route) { const { m: mm, ref } = await refFor(route.primary_model_id); const un = unmetRequirements(mergeRequires(PLATFORM_MINIMUMS[v.kind as PromptKind], v.parsed.requires ?? {}), ref.capabilities); if (un.length) problems.push(`the model routed for ${task} (${mm.display_name}) ${un.join(', ')}`); }
    }
    if (v.kind === 'evidence_labels') { const used = (await d.db.query(`select distinct evidence_label from public.findings`)).map((r: any) => r.evidence_label); problems.push(...checkLabelContinuity(v.parsed.labels, used).map(i => i.message)); }
    if (problems.length) throw new HttpError(422, problems.join('; '), problems);
    await asUser(d.db, u.id, q => q.query(`select public.activate_prompt_version($1)`, [v.id])); return { ok: true };
  });

  // ── investigations ─────────────────────────────────────────────────────────
  on('POST', '/api/investigations', async (u, _m, b) => {
    try {
      const id = await d.store.createInvestigation({ title: str(b.title, 'title', 300), problem: str(b.problem, 'problem', 8_000), industriesInclude: Array.isArray(b.industriesInclude) ? b.industriesInclude.map(String) : [], industriesExclude: Array.isArray(b.industriesExclude) ? b.industriesExclude.map(String) : [],
        requestedCapInr: b.capInr == null ? undefined : pos(b.capInr, 'cap'), createdBy: u.id, confidential: b.confidential !== false });
      return { id };
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(422, (e as Error).message); }
  });
  on('GET', '/api/investigations', async () => d.store.listInvestigations());
  on('GET', '/api/investigations/:id', async (_u, m) => {
    const id = m.groups!.id!; const inv = await d.store.investigation(id).catch(() => { throw new HttpError(404, 'unknown investigation'); });
    const plan = await d.store.stage(id, 'plan'); const research = await d.store.stage(id, 'research');
    return { investigation: inv, spentInr: await d.store.spendByInvestigation(id), plan: plan && { status: plan.status, plan: plan.plan, userEdits: plan.userEdits, estimate: plan.progress.estimate ?? null, error: null },
      research: research && { status: research.status, progress: research.progress }, searchLog: await d.store.searchLog(id), sources: (await d.store.linkedSources(id)).map(s => ({ handle: s.handle, title: s.record.title, type: s.record.sourceType, doi: s.record.doi, url: s.record.url, verification: s.verification, seen: s.record.abstract ? 'abstract' : 'metadata only' })),
      findings: await d.store.findings(id), approaches: await d.store.approaches(id), experiments: await d.store.experiments(id), nullResults: await d.store.nullResults(id), report: await d.store.latestReport(id) };
  });
  on('POST', '/api/investigations/:id/approve', async (u, m, b) => { try { await approvePlan(d.engine, m.groups!.id!, u.id, b?.plan); return { ok: true }; } catch (e) { throw new HttpError(422, (e as Error).message); } });
  on('POST', '/api/investigations/:id/reject', async (_u, m) => {
    const inv = await d.store.investigation(m.groups!.id!); if (inv.status !== 'awaiting_approval') throw new HttpError(409, 'only a plan awaiting approval can be rejected');
    await d.store.setStatus(inv.id, 'stopped_user'); await d.store.setCoverage(inv.id, 'incomplete_stopped', 'plan rejected by the founder before any research', null); return { ok: true };
  });
  on('POST', '/api/investigations/:id/stop', async (_u, m) => {
    const inv = await d.store.investigation(m.groups!.id!); if (!['researching', 'reporting'].includes(inv.status)) throw new HttpError(409, `cannot stop an investigation that is ${inv.status}`);
    await d.store.requestStop(inv.id); return { ok: true };
  });

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, body: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(type === 'application/json' ? JSON.stringify(body) : String(body)); };
    try {
      const url = new URL(req.url ?? '/', 'http://x'); const path = url.pathname.replace(/\/+$/, '') || '/';
      if (path === '/health') return send(200, { ok: true });
      if (path === '/') { res.writeHead(302, { location: '/setup' }); return res.end(); }
      if (path === '/setup') return send(200, setupPageHtml(), 'text/html; charset=utf-8');
      if (path === '/setup/config.json') return send(200, d.publicConfig);
      if (!path.startsWith('/api/')) return send(404, { error: 'not found' });
      const matches = routes.map(([method, re, h]) => ({ method, m: re.exec(path), h })).filter(r => r.m);
      if (!matches.length) return send(404, { error: 'not found' });
      const route = matches.find(r => r.method === req.method);                      // same path may serve several methods
      if (!route) return send(405, { error: 'method not allowed' });
      const user = await authenticate(req);
      let body: any = {}; if (req.method !== 'GET') { const chunks: Buffer[] = []; let size = 0; for await (const c of req) { size += c.length; if (size > 1_000_000) throw new HttpError(413, 'request too large'); chunks.push(c as Buffer); } const txt = Buffer.concat(chunks).toString('utf8'); if (txt) { try { body = JSON.parse(txt); } catch { throw new HttpError(400, 'invalid JSON'); } } }
      return send(200, await route.h(user, route.m!, body));
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, details: e.extra });
      console.error('api error', (e as Error).message); return send(500, { error: 'internal error' });
    }
  };
}
