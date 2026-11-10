import { BudgetNotConfigured, resolveBudgetConfig, type BudgetSettings, type Ledger } from '../budget';
import { num, type Db, type Sql } from '../db/sql';
import type { PriceRow } from '../pricing';
import type { ParsedPrompt, PromptKind } from '../prompts/parse';
import type { ModelCapabilities } from '../providers/types';
import { normalizeDoi, normalizeTitle, normalizeUrl } from '../sources/normalize';
import type { ToolCache } from '../sources/cache';
import type { SourceRecord } from '../sources/types';
import type { CallRecord, CallSink } from './metered';

export class RoutingIncomplete extends Error {}
export const REQUIRED_TASKS = ['stage1_plan', 'stage2_research', 'report'] as const;

export interface InvestigationRow {
  id: string; title: string; problem: string; industriesInclude: string[]; industriesExclude: string[]; status: string;
  promptSetId: string; routingSnapshotId: string; confidential: boolean; isTest: boolean; stopRequested: boolean; capInr: number;
  coverageStatus: string; coverageNote: string | null; coverageProfile: any; createdBy: string | null;
}
export interface ModelRow { id: string; provider: string; providerModel: string; displayName: string; status: string; capabilities: ModelCapabilities; confidentialOk: boolean }
export interface LoadedPromptSet { ids: Record<'stage1' | 'stage2' | 'template' | 'labels', string>; stage1: ParsedPrompt; stage2: ParsedPrompt; template: ParsedPrompt; labels: ParsedPrompt }
export type Routing = Record<string, { primary: ModelRow; fallback: ModelRow | null }>;

const rowToInv = (r: any): InvestigationRow => ({
  id: r.id, title: r.title, problem: r.problem, industriesInclude: r.industries_include ?? [], industriesExclude: r.industries_exclude ?? [], status: r.status,
  promptSetId: r.prompt_set_id, routingSnapshotId: r.routing_snapshot_id, confidential: r.confidential, isTest: r.is_test, stopRequested: r.stop_requested,
  capInr: num(r.cap_inr), coverageStatus: r.coverage_status, coverageNote: r.coverage_note, coverageProfile: r.coverage_profile, createdBy: r.created_by,
});
const rowToModel = (r: any): ModelRow => ({
  id: r.id, provider: r.provider, providerModel: r.provider_model, displayName: r.display_name, status: r.status, confidentialOk: !!r.confidential_ok,
  capabilities: { contextTokens: r.context_tokens, maxOutputTokens: r.max_output_tokens, structuredOutput: r.supports_structured_output, toolCalling: r.supports_tool_calling, embeddings: r.supports_embeddings, reasoningBilledAsOutput: r.reasoning_billed_as_output },
});
const MODEL_SELECT = `select m.*, public.model_confidential_ok(m.id) as confidential_ok from public.model_registry m`;

export class PgStore implements CallSink {
  constructor(private db: Db) {}

  // ── settings, prices, models ────────────────────────────────────────────────
  async settings(): Promise<BudgetSettings & { fxRateInrPerUsd: number | null; toolsEnabled: Record<string, boolean> }> {
    const [s] = await this.db.query(`select * from public.settings where id = 1`);
    return { investigationCapInr: s.investigation_cap_inr == null ? null : num(s.investigation_cap_inr), monthlyBudgetInr: s.monthly_budget_inr == null ? null : num(s.monthly_budget_inr),
      testRunCapInr: s.test_run_cap_inr == null ? null : num(s.test_run_cap_inr), wrapupReservePct: num(s.wrapup_reserve_pct), warnAtPct: num(s.warn_at_pct),
      fxRateInrPerUsd: s.fx_rate_inr_per_usd == null ? null : num(s.fx_rate_inr_per_usd), toolsEnabled: s.tools_enabled };
  }
  async priceRows(): Promise<PriceRow[]> {
    return (await this.db.query(`select * from public.model_prices`)).map(r => ({ modelRegistryId: r.model_registry_id, inputUsdPerM: num(r.input_usd_per_m), outputUsdPerM: num(r.output_usd_per_m),
      cachedInputUsdPerM: r.cached_input_usd_per_m == null ? undefined : num(r.cached_input_usd_per_m), effectiveFrom: String(r.effective_from instanceof Date ? r.effective_from.toISOString().slice(0, 10) : r.effective_from).slice(0, 10),
      verifiedAt: r.verified_at ? String(r.verified_at instanceof Date ? r.verified_at.toISOString() : r.verified_at) : null }));
  }
  async model(id: string): Promise<ModelRow | null> { const r = await this.db.query(`${MODEL_SELECT} where m.id = $1`, [id]); return r[0] ? rowToModel(r[0]) : null; }

  // ── creating work ───────────────────────────────────────────────────────────
  async createInvestigation(i: { title: string; problem: string; industriesInclude?: string[]; industriesExclude?: string[]; requestedCapInr?: number; createdBy: string | null; isTest?: boolean; confidential?: boolean }): Promise<string> {
    return this.db.tx(async q => {
      const [s] = await q.query(`select * from public.settings where id = 1`);
      const cfg = resolveBudgetConfig({ investigationCapInr: s.investigation_cap_inr == null ? null : num(s.investigation_cap_inr), monthlyBudgetInr: s.monthly_budget_inr == null ? null : num(s.monthly_budget_inr),
        testRunCapInr: null, wrapupReservePct: num(s.wrapup_reserve_pct), warnAtPct: num(s.warn_at_pct) }, { requestedCapInr: i.requestedCapInr, isTest: i.isTest });
      const active = await q.query(`select id, kind from public.prompt_versions where status = 'active'`);
      const byKind = Object.fromEntries(active.map((r: any) => [r.kind, r.id]));
      for (const k of ['stage1_plan', 'stage2_research', 'report_template', 'evidence_labels']) if (!byKind[k]) throw new Error(`no active prompt file of kind ${k}`);
      const routes = await q.query(`select * from public.model_routes`);
      const snap: Record<string, { primary: string; fallback: string | null }> = {};
      for (const r of routes) snap[r.task] = { primary: r.primary_model_id, fallback: r.fallback_model_id };
      const missing = REQUIRED_TASKS.filter(t => !snap[t]); if (missing.length) throw new RoutingIncomplete(`no model assigned for: ${missing.join(', ')}`);
      const [ps] = await q.query(`insert into public.prompt_sets(stage1_id, stage2_id, template_id, labels_id) values ($1,$2,$3,$4) returning id`, [byKind.stage1_plan, byKind.stage2_research, byKind.report_template, byKind.evidence_labels]);
      const [rs] = await q.query(`insert into public.routing_snapshots(routes) values ($1::jsonb) returning id`, [JSON.stringify(snap)]);
      const [inv] = await q.query(`insert into public.investigations(title, problem, industries_include, industries_exclude, prompt_set_id, routing_snapshot_id, confidential, is_test, cap_inr, created_by)
        values ($1,$2,$3::text[],$4::text[],$5,$6,$7,$8,$9,$10) returning id`,
        [i.title, i.problem, i.industriesInclude ?? [], i.industriesExclude ?? [], ps.id, rs.id, i.confidential ?? true, i.isTest ?? false, cfg.investigationCapInr, i.createdBy]);
      await q.query(`insert into public.run_stages(investigation_id, stage, status) values ($1,'plan','queued')`, [inv.id]);
      await q.query(`insert into public.jobs(kind, payload) values ('stage1', $1::jsonb)`, [JSON.stringify({ investigationId: inv.id })]);
      return inv.id as string;
    });
  }
  async enqueue(kind: string, payload: object) { await this.db.query(`insert into public.jobs(kind, payload) values ($1, $2::jsonb)`, [kind, JSON.stringify(payload)]); }

  // ── reading an investigation ────────────────────────────────────────────────
  async investigation(id: string): Promise<InvestigationRow> {
    const r = await this.db.query(`select * from public.investigations where id = $1`, [id]);
    if (!r[0]) throw new Error(`unknown investigation ${id}`); return rowToInv(r[0]);
  }
  async setStatus(id: string, status: string) { await this.db.query(`update public.investigations set status = $2, updated_at = now() where id = $1`, [id, status]); }
  async setCoverage(id: string, status: string, note: string | null, profile: unknown) {
    await this.db.query(`update public.investigations set coverage_status = $2, coverage_note = $3, coverage_profile = $4::jsonb, updated_at = now() where id = $1`, [id, status, note, JSON.stringify(profile)]);
  }
  async requestStop(id: string) { await this.db.query(`update public.investigations set stop_requested = true where id = $1`, [id]); }
  async stopRequested(id: string): Promise<boolean> { return !!(await this.db.query(`select stop_requested from public.investigations where id = $1`, [id]))[0]?.stop_requested; }

  async promptSet(inv: InvestigationRow): Promise<LoadedPromptSet> {
    const [ps] = await this.db.query(`select * from public.prompt_sets where id = $1`, [inv.promptSetId]);
    const ids = { stage1: ps.stage1_id, stage2: ps.stage2_id, template: ps.template_id, labels: ps.labels_id };
    const rows = await this.db.query(`select id, kind, parsed from public.prompt_versions where id = any($1::uuid[])`, [Object.values(ids)]);
    const by = (id: string): ParsedPrompt => { const r = rows.find((x: any) => x.id === id); if (!r?.parsed) throw new Error('prompt version missing or unparsed'); return r.parsed as ParsedPrompt; };
    return { ids, stage1: by(ids.stage1), stage2: by(ids.stage2), template: by(ids.template), labels: by(ids.labels) };
  }
  async routing(inv: InvestigationRow): Promise<Routing> {
    const [snap] = await this.db.query(`select routes from public.routing_snapshots where id = $1`, [inv.routingSnapshotId]);
    const out: Routing = {};
    for (const [task, r] of Object.entries(snap.routes as Record<string, { primary: string; fallback: string | null }>)) {
      const primary = await this.model(r.primary); if (!primary) throw new Error(`model ${r.primary} no longer exists`);
      out[task] = { primary, fallback: r.fallback ? await this.model(r.fallback) : null };
    }
    return out;
  }

  // ── stages ──────────────────────────────────────────────────────────────────
  async stage(invId: string, stage: 'plan' | 'research' | 'report') {
    const r = await this.db.query(`select * from public.run_stages where investigation_id = $1 and stage = $2 order by created_at desc limit 1`, [invId, stage]);
    return r[0] ? { id: r[0].id as string, status: r[0].status as string, plan: r[0].plan_json, userEdits: r[0].user_edits, progress: (r[0].progress ?? {}) as Record<string, any> } : null;
  }
  async ensureStage(invId: string, stage: 'plan' | 'research' | 'report') {
    return (await this.stage(invId, stage)) ?? (await this.db.query(`insert into public.run_stages(investigation_id, stage, status) values ($1,$2,'queued') returning id`, [invId, stage]).then(() => this.stage(invId, stage)))!;
  }
  async updateStage(id: string, patch: { status?: string; plan?: unknown; userEdits?: unknown; approvedBy?: string | null; error?: string | null; started?: boolean; finished?: boolean }) {
    await this.db.query(`update public.run_stages set status = coalesce($2, status), plan_json = coalesce($3::jsonb, plan_json), user_edits = coalesce($4::jsonb, user_edits),
      approved_by = coalesce($5, approved_by), approved_at = case when $5::uuid is not null then now() else approved_at end, error = $6,
      started_at = case when $7 and started_at is null then now() else started_at end, finished_at = case when $8 then now() else finished_at end where id = $1`,
      [id, patch.status ?? null, patch.plan === undefined ? null : JSON.stringify(patch.plan), patch.userEdits === undefined ? null : JSON.stringify(patch.userEdits),
       patch.approvedBy ?? null, patch.error ?? null, !!patch.started, !!patch.finished]);
  }
  async mergeProgress(id: string, patch: Record<string, unknown>) { await this.db.query(`update public.run_stages set progress = progress || $2::jsonb where id = $1`, [id, JSON.stringify(patch)]); }

  // ── search log, sources ─────────────────────────────────────────────────────
  async logSearch(e: { investigationId: string; runStageId: string | null; origin: 'plan' | 'followup'; tool: string; query: string; industry: string | null; status: string; resultCount: number | null; error?: string | null; costInr?: number }) {
    await this.db.query(`insert into public.search_log(investigation_id, run_stage_id, origin, tool, query, industry, status, result_count, error, cost_inr) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.investigationId, e.runStageId, e.origin, e.tool, e.query, e.industry, e.status, e.resultCount, e.error ?? null, e.costInr ?? 0]);
  }
  async upsertSource(r: SourceRecord): Promise<string> {
    const doi = r.doi ? normalizeDoi(r.doi) : null; const url = r.url ? normalizeUrl(r.url) : null;
    const found = await this.db.query(`select id from public.external_sources where ($1::text is not null and lower(doi) = $1) or ($2::text is not null and url_normalized = $2) limit 1`, [doi, url]);
    const basis = r.abstract ? 'abstract' : 'metadata_only';
    if (found[0]) { await this.db.query(`update public.external_sources set abstract = coalesce(abstract, $2), content_basis = case when abstract is null and $2 is not null then 'abstract' else content_basis end where id = $1`, [found[0].id, r.abstract ?? null]); return found[0].id; }
    const pub = r.publishedOn; const precision = !pub ? null : pub.length === 4 ? 'year' : pub.length === 7 ? 'month' : 'day';
    const date = !pub ? null : pub.length === 4 ? `${pub}-01-01` : pub.length === 7 ? `${pub}-01` : pub;
    const [row] = await this.db.query(`insert into public.external_sources(source_type, doi, url, url_normalized, title, title_normalized, authors, published_on, published_precision, abstract, oa_url, content_basis, retrieved_via)
      values ($1,$2,$3,$4,$5,$6,$7::text[],$8::date,$9,$10,$11,$12,$13) returning id`, [r.sourceType, doi, r.url ?? null, url, r.title, normalizeTitle(r.title), r.authors ?? [], date, precision, r.abstract ?? null, r.oaUrl ?? null, basis, r.retrievedVia]);
    return row.id;
  }
  async linkSource(invId: string, sourceId: string, handle: string, seq: number, subQuestionId: string | null, origin: 'plan' | 'followup') {
    await this.db.query(`insert into public.investigation_sources(investigation_id, source_id, handle, seq, sub_question_id, origin) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [invId, sourceId, handle, seq, subQuestionId, origin]);
  }
  async linkedSources(invId: string): Promise<Array<{ handle: string; sourceId: string; seq: number; record: SourceRecord & { id: string }; verification: string }>> {
    const rows = await this.db.query(`select i.handle, i.source_id, i.seq, s.* from public.investigation_sources i join public.external_sources s on s.id = i.source_id where i.investigation_id = $1 order by i.seq`, [invId]);
    return rows.map((r: any) => ({ handle: r.handle, sourceId: r.source_id, seq: r.seq, verification: r.verification_status,
      record: { id: r.source_id, sourceType: r.source_type, doi: r.doi ?? undefined, url: r.url ?? undefined, title: r.title, authors: r.authors ?? undefined, abstract: r.abstract ?? undefined, oaUrl: r.oa_url ?? undefined, retrievedVia: r.retrieved_via,
        publishedOn: r.published_on ? String(r.published_on instanceof Date ? r.published_on.toISOString().slice(0, 10) : r.published_on).slice(0, r.published_precision === 'year' ? 4 : r.published_precision === 'month' ? 7 : 10) : undefined } }));
  }
  async handlesForSubQuestion(invId: string, sq: string): Promise<string[]> { return (await this.db.query(`select handle from public.investigation_sources where investigation_id = $1 and sub_question_id = $2 order by seq`, [invId, sq])).map((r: any) => r.handle); }
  async setReportMeta(reportId: string, partial: boolean, banner: string | null) { await this.db.query(`update public.reports set partial = $2, banner = $3 where id = $1`, [reportId, partial, banner]); }
  async setSourceVerification(sourceId: string, status: string, detail: unknown) {
    await this.db.query(`update public.external_sources set verification_status = $2, verification_detail = $3::jsonb, verified_at = now() where id = $1`, [sourceId, status, JSON.stringify(detail ?? {})]);
  }

  // ── results ─────────────────────────────────────────────────────────────────
  async saveFinding(invId: string, f: { subQuestionId: string; claim: string; label: string; labelSetId: string; rationale: string | null; mechanism: string | null; limitations: string | null; sourceType: string; industry: string | null;
      verification: string; labelCheck: string; labelCheckNote: string | null; supportedLabel: string | null; extras: object;
      sources: Array<{ sourceId: string; quote: string | null; quoteVerified: boolean | null; reportsTestData: boolean | null; namesRealUse: boolean | null }>;
      commercial: Array<{ field: string; value: string | null; unit: string | null; sourceId: string | null; status: 'sourced' | 'not_estimated' }> }): Promise<string> {
    return this.db.tx(async q => {
      const [row] = await q.query(`insert into public.findings(investigation_id, sub_question_id, claim, evidence_label, label_set_id, label_rationale, mechanism, limitations, source_type, industry_of_origin, verification_status, label_check, label_check_note, supported_label, extras)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) returning id`,
        [invId, f.subQuestionId, f.claim, f.label, f.labelSetId, f.rationale, f.mechanism, f.limitations, f.sourceType, f.industry, f.verification, f.labelCheck, f.labelCheckNote, f.supportedLabel, JSON.stringify(f.extras)]);
      for (const s of f.sources) await q.query(`insert into public.finding_sources(finding_id, source_id, quote, quote_verified, reports_test_data, names_real_use) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [row.id, s.sourceId, s.quote, s.quoteVerified, s.reportsTestData, s.namesRealUse]);
      for (const c of f.commercial) await q.query(`insert into public.finding_commercial(finding_id, field, value, unit, source_id, status) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [row.id, c.field, c.value, c.unit, c.sourceId, c.status]);
      return row.id as string;
    });
  }
  async saveApproach(invId: string, a: { subQuestionId: string; name: string; industry: string | null; status: string; summary: string | null; reason: string | null; weakness: string | null; phFit: object; findingIds: string[];
      commercial: Array<{ field: string; value: string | null; unit: string | null; sourceId: string | null; status: 'sourced' | 'not_estimated' }> }): Promise<string> {
    return this.db.tx(async q => {
      const [row] = await q.query(`insert into public.approaches(investigation_id, sub_question_id, name, industry_of_origin, status, summary, reason, biggest_weakness, ph_fit, finding_ids) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::uuid[]) returning id`,
        [invId, a.subQuestionId, a.name, a.industry, a.status, a.summary, a.reason, a.weakness, JSON.stringify(a.phFit), a.findingIds]);
      for (const c of a.commercial) await q.query(`insert into public.approach_commercial(approach_id, field, value, unit, source_id, status) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [row.id, c.field, c.value, c.unit, c.sourceId, c.status]);
      return row.id as string;
    });
  }
  async saveNullResult(invId: string, subQuestionId: string, note: string) { await this.db.query(`insert into public.null_results(investigation_id, sub_question_id, note) values ($1,$2,$3)`, [invId, subQuestionId, note]); }
  async approaches(invId: string) { return this.db.query(`select * from public.approaches where investigation_id = $1 order by created_at`, [invId]); }
  async findings(invId: string) {
    const f = await this.db.query(`select * from public.findings where investigation_id = $1 order by created_at`, [invId]);
    const fs = await this.db.query(`select fs.*, i.handle from public.finding_sources fs join public.findings f on f.id = fs.finding_id left join public.investigation_sources i on i.source_id = fs.source_id and i.investigation_id = f.investigation_id where f.investigation_id = $1`, [invId]);
    const fc = await this.db.query(`select c.*, i.handle from public.finding_commercial c join public.findings f on f.id = c.finding_id left join public.investigation_sources i on i.source_id = c.source_id and i.investigation_id = f.investigation_id where f.investigation_id = $1`, [invId]);
    return f.map((x: any) => ({ ...x, sources: fs.filter((s: any) => s.finding_id === x.id), commercial: fc.filter((c: any) => c.finding_id === x.id) }));
  }
  async nullResults(invId: string) { return this.db.query(`select * from public.null_results where investigation_id = $1 order by created_at`, [invId]); }
  async experiments(invId: string) { return this.db.query(`select * from public.experiment_proposals where investigation_id = $1 order by rank nulls last, created_at`, [invId]); }
  async saveExperiments(invId: string, approachIds: Record<string, string>, exps: Array<{ approachName: string; hypothesis: string; variables: string[]; control: string | null; measurement: string | null; passFail: string | null; stop: string | null; rank: number; rationale: string | null }>) {
    for (const e of exps) await this.db.query(`insert into public.experiment_proposals(investigation_id, approach_id, approach_name, hypothesis, variables, control, measurement_method, pass_fail_criterion, stop_condition, rank, rank_rationale) values ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9,$10,$11)`,
      [invId, approachIds[normalizeTitle(e.approachName)] ?? null, e.approachName, e.hypothesis, e.variables, e.control, e.measurement, e.passFail, e.stop, e.rank, e.rationale]);
  }
  async rankApproach(approachId: string, r: { rank: number; confidence: string; rationale: string | null; uncertainty: string | null; weakness: string | null; nextStep: string | null }) {
    await this.db.query(`update public.approaches set rank = $2, confidence = $3, rank_rationale = $4, uncertainty_note = $5, biggest_weakness = coalesce($6, biggest_weakness), next_step = $7 where id = $1`, [approachId, r.rank, r.confidence, r.rationale, r.uncertainty, r.weakness, r.nextStep]);
  }
  async createReport(invId: string, templateId: string, partial: boolean, banner: string | null): Promise<string> {
    const [r] = await this.db.query(`insert into public.reports(investigation_id, template_id, partial, banner) values ($1,$2,$3,$4) returning id`, [invId, templateId, partial, banner]); return r.id;
  }
  async saveSection(reportId: string, s: { key: string; position: number; title: string; content: string; findingIds: string[] }) {
    await this.db.query(`insert into public.report_sections(report_id, section_key, position, title, content, finding_ids) values ($1,$2,$3,$4,$5,$6::uuid[]) on conflict (report_id, section_key) do update set content = excluded.content, finding_ids = excluded.finding_ids`, [reportId, s.key, s.position, s.title, s.content, s.findingIds]);
  }
  async latestReport(invId: string) {
    const r = (await this.db.query(`select * from public.reports where investigation_id = $1 order by created_at desc limit 1`, [invId]))[0]; if (!r) return null;
    return { ...r, sections: await this.db.query(`select * from public.report_sections where report_id = $1 order by position`, [r.id]) };
  }
  async listInvestigations() {
    return this.db.query(`select i.id, i.title, i.status, i.cap_inr, i.coverage_status, i.coverage_note, i.created_at, public.investigation_spend_inr(i.id) as spent_inr from public.investigations i order by i.created_at desc limit 200`);
  }
  async searchLog(invId: string) { return this.db.query(`select * from public.search_log where investigation_id = $1 order by created_at`, [invId]); }

  // ── money ───────────────────────────────────────────────────────────────────
  async record(c: CallRecord): Promise<void> {
    await this.db.tx(async q => {
      const [m] = await q.query(`insert into public.model_calls(investigation_id, run_stage_id, task, model_registry_id, finish_reason, error_kind, schema_valid, schema_failures, retries, latency_ms, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`, [c.investigationId, c.runStageId, c.task, c.model.registryId, c.finishReason, c.errorKind, c.errorKind === null, c.schemaFailures, c.retries, c.latencyMs, c.usage.inputTokens, c.usage.outputTokens, c.usage.cachedInputTokens ?? null, c.usage.reasoningTokens ?? null]);
      await q.query(`insert into public.cost_ledger(investigation_id, run_stage_id, call_type, provider, model_or_tool, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, task, model_registry_id, model_call_id, price_input_usd_per_m, price_output_usd_per_m, price_cached_usd_per_m, fx_rate, is_test, cost_usd, cost_inr)
        values ($1,$2,'llm',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [c.investigationId, c.runStageId, c.model.provider, c.model.providerModel, c.usage.inputTokens, c.usage.outputTokens, c.usage.cachedInputTokens ?? null, c.usage.reasoningTokens ?? null, c.task, c.model.registryId, m.id, c.price.inputUsdPerM, c.price.outputUsdPerM, c.price.cachedInputUsdPerM ?? null, c.fxRate, c.isTest, c.costUsd, c.costInr]);
    });
  }
  ledger(invId: string | null): Ledger {
    return {
      investigationSpentInr: async () => invId ? num((await this.db.query(`select public.investigation_spend_inr($1) s`, [invId]))[0].s) : 0,
      monthSpentInr: async () => num((await this.db.query(`select public.month_spend_inr() s`))[0].s),
      testMonthSpentInr: async () => num((await this.db.query(`select public.month_test_spend_inr() s`))[0].s),
    };
  }
  async spendByInvestigation(invId: string) { return num((await this.db.query(`select public.investigation_spend_inr($1) s`, [invId]))[0].s); }

  // ── tool cache ──────────────────────────────────────────────────────────────
  toolCache(): ToolCache {
    return {
      get: async (adapter, hash) => { const r = (await this.db.query(`select response, fetched_at, ttl_seconds from public.tool_cache where adapter = $1 and request_hash = $2`, [adapter, hash]))[0];
        return r ? { response: r.response, fetchedAt: new Date(r.fetched_at).getTime(), ttlSeconds: r.ttl_seconds } : null; },
      put: async (adapter, hash, response, ttl) => { await this.db.query(`insert into public.tool_cache(adapter, request_hash, response, ttl_seconds) values ($1,$2,$3::jsonb,$4) on conflict (adapter, request_hash) do update set response = excluded.response, fetched_at = now(), ttl_seconds = excluded.ttl_seconds`, [adapter, hash, JSON.stringify(response), ttl]); },
    };
  }
}
export type { Sql };
