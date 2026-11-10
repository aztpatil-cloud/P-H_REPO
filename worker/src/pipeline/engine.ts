import { verifyDoi } from '../verify/doi';
import { verifyUrl, type UrlDeps } from '../verify/url';
import { combineSourceChecks, verifyFinding } from '../verify/finding';
import type { CheckStatus } from '../verify/types';
import { evaluateLabelRules, strongestSupported, type CitedSource } from '../prompts/label-rules';
import { renderPrompt } from '../prompts/parse';
import { ProviderError } from '../providers/errors';
import type { Message, ToolDef } from '../providers/types';
import { RetrievedSet } from '../sources/retrieved-set';
import { SourceError, type DoiResolver, type SourceRecord } from '../sources/types';
import { normalizeTitle } from '../sources/normalize';
import { buildContext, preflight, PreflightError, type ContextDeps, type RunContext } from './context';
import { BudgetStop } from './metered';
import { checkPlan, estimateResearchCostInr, planKey } from './plan';
import { writeReport } from './report';
import { stage1PlanSchema, stage2SubQuestionSchema, synthesisSchema, type Stage1Plan } from './schemas';
import { stage1Variables, stage2Variables } from './variables';
import type { PgStore } from './store';

export interface EngineDeps extends ContextDeps {
  doiResolver: DoiResolver; urlDeps: UrlDeps;
  followupsPerSubQuestion?: number; maxPlanItems?: number; maxSourcesPerSubQuestion?: number; toolCostInr?: number;
}
const FOLLOWUPS = 3; const MAX_PLAN_ITEMS = 60; const MAX_SOURCES_IN_PROMPT = 40;
const sys = (text: string): Message => ({ role: 'system', parts: [{ type: 'text', text }] });
const usr = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });
const asst = (text: string): Message => ({ role: 'assistant', parts: [{ type: 'text', text }] });

// ────────────────────────────────────────────────────────────────────────────────
// Stage 1: problem breakdown and search plan (cheap; ends at the approval checkpoint)
// ────────────────────────────────────────────────────────────────────────────────
export async function runStage1(d: EngineDeps, invId: string): Promise<void> {
  const store = d.store; let inv = await store.investigation(invId);
  if (inv.status !== 'planning') return;                                   // idempotent: a re-delivered job does nothing
  const stage = await store.ensureStage(invId, 'plan'); await store.updateStage(stage.id, { status: 'running', started: true });
  try {
    const ctx = await buildContext(d, invId); preflight(ctx);
    const names = Object.keys(ctx.sources.searchers);
    const text = renderPrompt(ctx.promptSet.stage1.body, stage1Variables({ problem: inv.problem, industriesInclude: inv.industriesInclude, industriesExclude: inv.industriesExclude,
      sources: names.map(n => ({ name: n, description: ctx.sources.descriptions[n] ?? '' })), labels: ctx.labels, today: ctx.now() }));
    const llm = ctx.llm('stage1_plan', stage.id); const model = ctx.modelRef('stage1_plan'); const schema = stage1PlanSchema(names);
    const max = d.maxPlanItems ?? MAX_PLAN_ITEMS; const maxOut = Math.min(model.capabilities.maxOutputTokens, 8_000);
    const messages: Message[] = [sys(text), usr('Produce the plan now.')];
    let plan = (await llm.generate({ model, messages, outputSchema: schema, maxOutputTokens: maxOut })).structured as Stage1Plan;
    let problems = checkPlan(plan, names, max);
    if (problems.length) {                                                  // one corrective re-ask, then fail loudly
      plan = (await llm.generate({ model, outputSchema: schema, maxOutputTokens: maxOut, messages: [...messages, asst(JSON.stringify(plan)), usr(`The plan has problems: ${problems.join('; ')}. Return a corrected plan.`)] })).structured as Stage1Plan;
      problems = checkPlan(plan, names, max);
      if (problems.length) throw new Error(`the model could not produce a valid plan: ${problems.join('; ')}`);
    }
    const estimate = estimateResearchCostInr(plan, ctx.modelRef('stage2_research'), ctx.priceBook, ctx.fx, ctx.now());
    await store.updateStage(stage.id, { status: 'awaiting_approval', plan, finished: true });
    await store.mergeProgress(stage.id, { estimate, original: plan });
    await store.setStatus(invId, 'awaiting_approval');
  } catch (e) { await failRun(store, invId, stage.id, e); }
}

async function failRun(store: PgStore, invId: string, stageId: string | null, e: unknown) {
  const msg = e instanceof PreflightError ? e.message : e instanceof BudgetStop ? `the budget was reached before the plan could be produced (${e.reason})` : (e as Error).message;
  if (stageId) await store.updateStage(stageId, { status: 'failed', error: msg, finished: true });
  await store.setStatus(invId, 'failed');
  await store.setCoverage(invId, 'incomplete_error', `failed: ${msg}`, null);
}

// ────────────────────────────────────────────────────────────────────────────────
// Approval checkpoint
// ────────────────────────────────────────────────────────────────────────────────
export async function approvePlan(d: Pick<EngineDeps, 'store' | 'sourcesFor' | 'maxPlanItems'>, invId: string, userId: string, edited?: Stage1Plan): Promise<void> {
  const store = d.store; const inv = await store.investigation(invId);
  if (inv.status !== 'awaiting_approval') throw new Error(`the plan cannot be approved while the investigation is ${inv.status}`);
  const planStage = (await store.stage(invId, 'plan'))!; const original = planStage.plan as Stage1Plan;
  const plan = edited ?? original; const names = Object.keys(d.sourcesFor(inv).searchers);
  const problems = checkPlan(plan, names, d.maxPlanItems ?? MAX_PLAN_ITEMS); if (problems.length) throw new Error(`the edited plan is not valid: ${problems.join('; ')}`);
  const kept = new Set(plan.search_plan.map(s => planKey(s.sub_question_id, s.source, s.query)));
  for (const s of original.search_plan) if (!kept.has(planKey(s.sub_question_id, s.source, s.query)))
    await store.logSearch({ investigationId: invId, runStageId: planStage.id, origin: 'plan', tool: s.source, query: s.query, industry: s.industry, status: 'skipped_user', resultCount: null });
  await store.updateStage(planStage.id, { status: 'approved', userEdits: edited ?? null, approvedBy: userId });
  const rs = await store.ensureStage(invId, 'research'); await store.updateStage(rs.id, { plan, status: 'queued' });
  await store.setStatus(invId, 'researching'); await store.enqueue('research', { investigationId: invId });
}

// ────────────────────────────────────────────────────────────────────────────────
// Stage 2: research, synthesis, report
// ────────────────────────────────────────────────────────────────────────────────
type StopReason = 'budget' | 'user' | null;

const SEARCH_TOOL = (names: string[]): ToolDef => ({ name: 'search_sources', description: 'Run ONE extra search when a result points to something the plan did not cover. Limited number of uses.',
  inputSchema: { type: 'object', required: ['source', 'query', 'reason'], properties: { source: { type: 'string', enum: names }, query: { type: 'string' }, reason: { type: 'string', description: 'what this could reveal' } } } });

const sourceLine = (handle: string, r: SourceRecord) =>
  `[${handle}] ${r.title} | ${r.sourceType} | ${r.publishedOn?.slice(0, 4) ?? 'n.d.'} | seen: ${r.abstract ? 'abstract' : 'metadata only'}${r.abstract ? `\n    ${r.abstract.replace(/\s+/g, ' ').slice(0, 1100)}` : ''}`;

export async function runResearch(d: EngineDeps, invId: string): Promise<void> {
  const store = d.store; let inv = await store.investigation(invId);
  if (inv.status !== 'researching') return;
  const rs = (await store.stage(invId, 'research'))!; await store.updateStage(rs.id, { status: 'running', started: true });
  let ctx: RunContext;
  try { ctx = await buildContext(d, invId); preflight(ctx); } catch (e) { await failRun(store, invId, rs.id, e); return; }

  const plan = rs.plan as Stage1Plan; const labelsByKey = new Map(ctx.labels.map(l => [l.key, l]));
  const set = new RetrievedSet(); const handleToId = new Map<string, string>(); const verification = new Map<string, CheckStatus>();
  for (const l of await store.linkedSources(invId)) { const { handle } = set.add(l.record); handleToId.set(handle, l.sourceId); verification.set(handle, l.verification === 'unverified' ? 'unverified' : (l.verification as CheckStatus)); }
  let seq = handleToId.size; let progress = rs.progress as { completed?: string[]; executed?: string[]; synthesisDone?: boolean };
  const completed = new Set(progress.completed ?? []); const executed = new Set(progress.executed ?? []);
  const followCap = d.followupsPerSubQuestion ?? FOLLOWUPS; const maxSrc = d.maxSourcesPerSubQuestion ?? MAX_SOURCES_IN_PROMPT;
  const names = Object.keys(ctx.sources.searchers); let stop: StopReason = null; let hadErrors = false;
  const llm = ctx.llm('stage2_research', rs.id); const model = ctx.modelRef('stage2_research');
  const systemText = renderPrompt(ctx.promptSet.stage2.body, stage2Variables({ problem: inv.problem, approvedPlan: plan, sources: names.map(n => ({ name: n, description: ctx.sources.descriptions[n] ?? '' })), labels: ctx.labels, today: ctx.now(), capInr: inv.capInr, spentInr: await store.spendByInvestigation(invId) }))
    + `\n\nPlatform notes: sources are identified by handles such as S3; cite only handles shown to you. Each source line says what the system actually saw (abstract or metadata only).`;

  const checkpoint = async () => { if (await store.stopRequested(invId)) throw Object.assign(new Error('stop'), { userStop: true }); if (ctx.governor.exhaustedReason) throw new BudgetStop(ctx.governor.exhaustedReason, 0); };

  // one search, logged and cached; returns the handles it produced
  async function search(sq: string, item: { source: string; query: string; industry: string }, origin: 'plan' | 'followup'): Promise<string[]> {
    await checkpoint();
    const auth = await ctx.governor.authorize(d.toolCostInr ?? 0); if (!auth.ok) throw new BudgetStop(auth.reason, auth.remainingInr);
    const log = (status: string, count: number | null, error?: string) => store.logSearch({ investigationId: invId, runStageId: rs.id, origin, tool: item.source, query: item.query, industry: item.industry, status, resultCount: count, error: error ?? null });
    try {
      const src = ctx.sources.searchers[item.source]; if (!src) { await log('error', null, 'unknown source'); return []; }
      const out = await src.search({ query: item.query, limit: 10 });
      await log(out.records.length === 0 ? 'empty' : out.cacheHit ? 'cache_hit' : 'results', out.records.length);
      const handles: string[] = [];
      for (const r of out.records) {
        const { handle, created } = set.add(r);
        if (created) { seq++; const id = await store.upsertSource(r); handleToId.set(handle, id); await store.linkSource(invId, id, handle, seq, sq, origin); verification.set(handle, 'unverified'); }
        handles.push(handle);
      }
      return handles;
    } catch (e) {
      if (e instanceof SourceError) { await log(e.kind === 'rate_limit' ? 'rate_limited' : e.kind === 'call_limit' ? 'skipped_budget' : 'error', null, e.message); return []; }
      throw e;
    } finally { ctx.governor.release(auth.reservation); }
  }

  async function verifySource(handle: string): Promise<CheckStatus> {
    if (verification.get(handle) && verification.get(handle) !== 'unverified') return verification.get(handle)!;
    const rec = set.resolve(handle); if (!rec) return 'unverified';
    const doi = rec.doi ? await verifyDoi({ doi: rec.doi, storedTitle: rec.title }, d.doiResolver) : undefined;
    const url = (!doi || doi.status !== 'verified') && rec.url ? await verifyUrl({ url: rec.url, expectedTitle: rec.title }, d.urlDeps) : undefined;
    const status = combineSourceChecks({ doi, url }); verification.set(handle, status);
    const id = handleToId.get(handle); if (id) await store.setSourceVerification(id, status, { doi, url });
    return status;
  }

  async function processSubQuestion(sq: Stage1Plan['sub_questions'][number]) {
    const items = plan.search_plan.filter(s => s.sub_question_id === sq.id);
    const handles: string[] = []; let cut = false;
    try {
      for (const it of items) {
        const key = planKey(sq.id, it.source, it.query);
        if (executed.has(key)) continue;
        handles.push(...await search(sq.id, it, 'plan')); executed.add(key); await store.mergeProgress(rs.id, { executed: [...executed] });
      }
    } catch (e) { if (e instanceof BudgetStop) cut = true; else throw e; }       // user stop propagates; budget stop still extracts what was found
    for (const h of await store.handlesForSubQuestion(invId, sq.id)) if (!handles.includes(h)) handles.push(h);   // sources kept from an earlier attempt
    const uniq = [...new Set(handles)].slice(0, maxSrc);
    const lines = uniq.map(h => sourceLine(h, set.resolve(h)!)).join('\n') || '(the planned searches returned nothing)';
    const messages: Message[] = [sys(systemText), usr(
      `Sub-question ${sq.id}: ${sq.question}\nFunction: ${sq.function_restatement}\nMechanism (${sq.mechanism_is_assumption ? 'an assumption' : 'believed'}): ${sq.mechanism}\n\nRetrieved sources:\n${lines}\n\n` +
      `You may use search_sources at most ${followCap} times for follow-ups. When you have read enough, reply with the single word DONE.`)];
    let follow = 0;
    try {
      for (let round = 0; !cut && round <= followCap; round++) {
        const r = await llm.generate({ model, messages, tools: [SEARCH_TOOL(names)], maxOutputTokens: Math.min(model.capabilities.maxOutputTokens, 2_000) });
        if (!r.toolCalls.length) { messages.push(asst(r.text ?? 'DONE')); break; }
        messages.push({ role: 'assistant', parts: r.toolCalls.map(c => ({ type: 'tool_call' as const, id: c.id, name: c.name, args: c.args })) });
        const results: Message['parts'] = [];
        for (const c of r.toolCalls) {
          let result: unknown;
          if (follow >= followCap) result = { error: 'follow-up limit reached; no more searches are available' };
          else { follow++; const a = c.args as { source: string; query: string };
            const hs = await search(sq.id, { source: String(a.source), query: String(a.query), industry: 'follow-up' }, 'followup');
            result = { sources: [...new Set(hs)].slice(0, 15).map(h => sourceLine(h, set.resolve(h)!)) }; hs.forEach(h => { if (!uniq.includes(h) && uniq.length < maxSrc + 15) uniq.push(h); }); }
          results.push({ type: 'tool_result', callId: c.id, name: c.name, result });
        }
        messages.push({ role: 'tool', parts: results });
        if (round === followCap) messages.push(asst('DONE'));
      }
    } catch (e) { if (e instanceof BudgetStop) cut = true; else throw e; }
    if (cut) ctx.governor.beginWrapup();                                    // research is over; spend only the wrap-up reserve to keep what we found

    // final structured extraction for this sub-question
    const finalMsgs = [...messages.filter(m => m.role !== 'tool' && !(m.role === 'assistant' && m.parts.some(p => p.type === 'tool_call'))), usr('Now return the structured results for this sub-question. Use only the sources shown above and in the search results you received.')];
    const extract = () => llm.generate({ model, messages: finalMsgs, outputSchema: stage2SubQuestionSchema(ctx.labels.map(l => l.key)), maxOutputTokens: Math.min(model.capabilities.maxOutputTokens, 12_000) });
    let res; 
    try { res = await extract(); }
    catch (e) { if (!(e instanceof BudgetStop) || ctx.governor.phase === 'wrapup') throw e; ctx.governor.beginWrapup(); cut = true; res = await extract(); }   // one more try from the wrap-up reserve
    await saveResults(sq.id, res.structured as any);
    if (cut) throw new BudgetStop(ctx.governor.exhaustedReason ?? 'investigation_cap', 0);   // saved, but the research stops here
  }

  async function saveResults(sqId: string, out: any) {
    const savedIds: string[] = []; const commercialOf = async (items: any[], adjustments: string[]) => items.map((c: any) => {
      const hid = c.source_ref ? handleToId.get(c.source_ref) : undefined;
      if (c.status === 'sourced' && c.value && hid && set.has(c.source_ref)) return { field: c.field, value: String(c.value), unit: c.unit ?? null, sourceId: hid, status: 'sourced' as const };
      if (c.status === 'sourced') adjustments.push(`commercial "${c.field}" had no valid retrieved source and was recorded as not estimated`);
      return { field: c.field, value: null, unit: null, sourceId: null, status: 'not_estimated' as const };
    });
    for (const f of out.findings as any[]) {
      const refs: string[] = f.sources.map((s: any) => s.ref); const { valid, rejected } = set.checkRefs(refs);
      for (const h of valid) await verifySource(h);
      const sourceStatus: Record<string, CheckStatus> = Object.fromEntries(valid.map(h => [h, verification.get(h) ?? 'unverified']));
      const v = verifyFinding({ sourceRefs: refs, quotes: f.quotes, sourceStatus }, set);
      const cited: CitedSource[] = valid.map(h => { const m = f.sources.find((s: any) => s.ref === h); const qs = v.quoteResults.filter(q => q.ref === h);
        return { handle: h, sourceType: set.resolve(h)!.sourceType, verification: sourceStatus[h]!, reportsTestData: m?.reports_test_data ?? null, namesRealUse: m?.names_real_use ?? null, hasVerifiedQuote: qs.some(q => q.result.verified) }; });
      const label = labelsByKey.get(f.evidence_label)!; const adjustments: string[] = [];
      const check = label.rules ? evaluateLabelRules(label.rules, cited) : null; const best = strongestSupported(ctx.labels, cited);
      if (rejected.length) adjustments.push(`references to unretrieved sources were dropped: ${rejected.join(', ')}`);
      const platformType = cited[0]?.sourceType; if (platformType && platformType !== f.source_type) adjustments.push(`source_type set from the cited source (${platformType}) instead of the model's "${f.source_type}"`);
      const quoteFor = (h: string) => v.quoteResults.find(q => q.ref === h);
      const id = await store.saveFinding(invId, {
        subQuestionId: sqId, claim: f.claim, label: f.evidence_label, labelSetId: ctx.promptSet.ids.labels, rationale: f.label_rationale, mechanism: f.mechanism, limitations: f.limitations, sourceType: platformType ?? f.source_type, industry: f.industry_of_origin,
        verification: v.status, labelCheck: check ? (check.ok ? 'passed' : 'failed') : 'not_checked', labelCheckNote: check && !check.ok ? check.reason ?? null : null, supportedLabel: best?.key ?? null, extras: { adjustments, rejectedRefs: rejected, verificationReasons: v.reasons },
        sources: valid.map(h => { const m = f.sources.find((s: any) => s.ref === h); const q = quoteFor(h); return { sourceId: handleToId.get(h)!, quote: q?.quote ?? null, quoteVerified: q ? q.result.verified : null, reportsTestData: m?.reports_test_data ?? null, namesRealUse: m?.names_real_use ?? null }; }),
        commercial: await commercialOf(f.commercial ?? [], adjustments),
      });
      savedIds.push(id);
    }
    for (const a of out.approaches as any[]) {
      const adjustments: string[] = [];
      await store.saveApproach(invId, { subQuestionId: sqId, name: a.name, industry: a.industry_of_origin, status: a.status, summary: a.summary, reason: a.reason, weakness: a.biggest_weakness, phFit: a.ph_fit,
        findingIds: (a.finding_indexes as number[]).map(i => savedIds[i]).filter(Boolean) as string[], commercial: await commercialOf(a.commercial ?? [], adjustments) });
    }
    for (const n of out.null_results as any[]) await store.saveNullResult(invId, sqId, n.note);
    if (!out.findings.length && !out.null_results.length && !out.approaches.length) await store.saveNullResult(invId, sqId, 'The model returned no findings and no explanation for this sub-question.');
  }

  // ── the research loop ──
  try {
    for (const sq of plan.sub_questions) {
      if (completed.has(sq.id)) continue;
      await checkpoint();
      try { await processSubQuestion(sq); }
      catch (e) {
        if (e instanceof BudgetStop || (e as any).userStop) throw e;
        if (e instanceof ProviderError && e.kind !== 'auth') { hadErrors = true; await store.saveNullResult(invId, sq.id, `This sub-question could not be completed (${e.kind}): ${e.message}`); }
        else throw e;
      }
      completed.add(sq.id); await store.mergeProgress(rs.id, { completed: [...completed] });
    }
  } catch (e) {
    if (e instanceof BudgetStop) stop = 'budget'; else if ((e as any).userStop) stop = 'user'; else { await failRun(store, invId, rs.id, e); return; }
  }
  if (stop === 'budget') ctx.governor.beginWrapup();

  // ── what was not done, recorded honestly ──
  const skippedStatus = stop === 'user' ? 'skipped_user' : 'skipped_budget';
  if (stop) for (const it of plan.search_plan) if (!executed.has(planKey(it.sub_question_id, it.source, it.query)))
    await store.logSearch({ investigationId: invId, runStageId: rs.id, origin: 'plan', tool: it.source, query: it.query, industry: it.industry, status: skippedStatus, resultCount: null });

  // ── synthesis: ranking and experiments (model only if allowed) ──
  const profile = await coverageProfile(store, ctx, invId, names);
  if (!progress.synthesisDone && stop !== 'user' && completed.size > 0) {
    try {
      const approaches = await store.approaches(invId);
      if (approaches.length) {
        const msgs: Message[] = [sys(systemText), usr(`All sub-questions are done. Rank the kept directions and propose experiments.\n\nApproaches and their findings:\n${JSON.stringify(approaches.map((a: any) => ({ name: a.name, status: a.status, industry: a.industry_of_origin, summary: a.summary, reason: a.reason, weakness: a.biggest_weakness, phFit: a.ph_fit })))}\n\nLimited coverage run: ${profile.limited ? 'yes' : 'no'}.`)];
        const out = (await llm.generate({ model, messages: msgs, outputSchema: synthesisSchema, maxOutputTokens: Math.min(model.capabilities.maxOutputTokens, 8_000) })).structured as any;
        const idByName: Record<string, string> = Object.fromEntries(approaches.map((a: any) => [normalizeTitle(a.name), a.id]));
        for (const r of out.ranking as any[]) {
          const id = idByName[normalizeTitle(r.approach_name)]; if (!id) continue;
          const capped = profile.limited && r.confidence === 'high';          // the Architect's rule: no "high" on a limited-coverage run
          await store.rankApproach(id, { rank: r.rank, confidence: capped ? 'medium' : r.confidence, rationale: r.rationale, weakness: r.biggest_weakness, nextStep: r.next_step,
            uncertainty: capped ? `${r.uncertainty_note} (Confidence capped at medium by the platform: this was a limited-coverage run.)` : r.uncertainty_note });
        }
        await store.saveExperiments(invId, idByName, (out.experiments as any[]).map(e => ({ approachName: e.approach_name, hypothesis: e.hypothesis, variables: e.variables, control: e.control, measurement: e.measurement_method, passFail: e.pass_fail_criterion, stop: e.stop_condition, rank: e.rank, rationale: e.rank_rationale })));
      }
      await store.mergeProgress(rs.id, { synthesisDone: true });
    } catch (e) {
      if (e instanceof BudgetStop) { stop = stop ?? 'budget'; ctx.governor.beginWrapup(); } else if (e instanceof ProviderError && e.kind !== 'auth') hadErrors = true; else { await failRun(store, invId, rs.id, e); return; }
    }
  }

  // ── coverage record, then the report ──
  const finalProfile = await coverageProfile(store, ctx, invId, names);
  const complete = !stop && !hadErrors && completed.size === plan.sub_questions.length;
  const coverageStatus = complete ? 'complete' : stop === 'budget' ? 'incomplete_budget' : stop === 'user' ? 'incomplete_stopped' : 'incomplete_error';
  const note = complete ? null : stop === 'budget' ? 'incomplete: budget reached' : stop === 'user' ? 'incomplete: stopped by user' : 'incomplete: some sub-questions failed';
  await store.setCoverage(invId, coverageStatus, note, finalProfile);
  await store.setStatus(invId, 'reporting');
  try { await writeReport(store, ctx, plan, finalProfile, { allowModel: stop !== 'user', reason: stop === 'user' ? 'the run was stopped by the founder' : stop === 'budget' ? 'the budget was reached' : null }); }
  catch (e) { await failRun(store, invId, rs.id, e); return; }
  await store.updateStage(rs.id, { status: stop ? 'stopped' : 'done', finished: true });
  await store.setStatus(invId, stop === 'budget' ? 'stopped_budget' : stop === 'user' ? 'stopped_user' : 'complete');
}

export interface CoverageProfile { limited: boolean; reasons: string[]; sourcesAvailable: string[]; sourcesWithResults: string[]; contentBasis: Record<string, number>; queries: Record<string, number> }

export async function coverageProfile(store: PgStore, ctx: RunContext, invId: string, available: string[]): Promise<CoverageProfile> {
  const log = await store.searchLog(invId); const linked = await store.linkedSources(invId);
  const queries: Record<string, number> = {}; for (const l of log) queries[l.status] = (queries[l.status] ?? 0) + 1;
  queries.followups = log.filter((l: any) => l.origin === 'followup').length;
  const contentBasis = { abstract: linked.filter(l => l.record.abstract).length, metadata_only: linked.filter(l => !l.record.abstract).length, full_text: 0 };
  const reasons: string[] = [];
  if (available.length < 3) reasons.push(`only ${available.length} source(s) searched (${available.join(', ')}); no patents, web or other source types`);
  if (contentBasis.full_text === 0) reasons.push('abstracts only; no full texts were read');
  return { limited: reasons.length > 0, reasons, sourcesAvailable: available, sourcesWithResults: [...new Set(log.filter((l: any) => ['results', 'cache_hit'].includes(l.status)).map((l: any) => l.tool))] as string[], contentBasis, queries };
}
