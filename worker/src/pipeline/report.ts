import { renderPrompt, type SectionDef } from '../prompts/parse';
import { ProviderError } from '../providers/errors';
import { BudgetStop } from './metered';
import type { RunContext } from './context';
import { reportSectionSchema } from './schemas';
import type { PgStore } from './store';

const WRITER_RULES = `You are writing one section of an internal R&D report. Use ONLY the records supplied in the data pack: do not add facts, figures, products, sources or quotations from memory.
Cite sources by their handle in square brackets, for example [S3]. A claim that no source supports must be called Our hypothesis.
Show each finding's evidence label and say plainly when its sources are unverified, when only an abstract was seen, or when a label is flagged as not supported by its sources.
Commercial figures may be stated only from the commercial records in the pack; otherwise write "not estimated". Never invent a number.
If the evidence for this section is thin or absent, say so plainly instead of filling space.`;

export const countWords = (s: string) => (s.trim().match(/\S+/g) ?? []).length;
const cited = (text: string) => [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map(m => m[1]!))];

export interface DataPack { restatement: unknown; coverage: unknown; findings: any[]; approaches: any[]; experiments: any[]; nullResults: any[]; sources: Array<{ handle: string; title: string; type: string; year: string | null; verification: string; contentBasis: string }> }

export async function buildDataPack(store: PgStore, ctx: RunContext, plan: any, coverage: unknown): Promise<DataPack> {
  const [findings, approaches, experiments, nulls, linked] = await Promise.all([store.findings(ctx.inv.id), store.approaches(ctx.inv.id), store.experiments(ctx.inv.id), store.nullResults(ctx.inv.id), store.linkedSources(ctx.inv.id)]);
  const byId = new Map(linked.map(l => [l.sourceId, l]));
  return {
    restatement: plan?.problem_restatement ?? null, coverage,
    sources: linked.map(l => ({ handle: l.handle, title: l.record.title, type: l.record.sourceType, year: l.record.publishedOn?.slice(0, 4) ?? null, verification: l.verification, contentBasis: l.record.abstract ? 'abstract' : 'metadata only' })),
    findings: findings.map((f: any) => ({ id: f.id, subQuestion: f.sub_question_id, claim: f.claim, label: f.evidence_label, rationale: f.label_rationale, mechanism: f.mechanism, limitations: f.limitations, industry: f.industry_of_origin,
      verification: f.verification_status, labelCheck: f.label_check, labelCheckNote: f.label_check_note, strongestSupportedLabel: f.supported_label,
      sources: f.sources.map((s: any) => ({ handle: byId.get(s.source_id)?.handle ?? s.handle, quoteVerified: s.quote_verified })),
      commercial: f.commercial.map((c: any) => ({ field: c.field, value: c.value, unit: c.unit, status: c.status, source: c.handle ?? null })) })),
    approaches: approaches.map((a: any) => ({ name: a.name, industry: a.industry_of_origin, status: a.status, summary: a.summary, reason: a.reason, biggestWeakness: a.biggest_weakness, phFit: a.ph_fit, rank: a.rank, confidence: a.confidence, rationale: a.rank_rationale, uncertainty: a.uncertainty_note, nextStep: a.next_step })),
    experiments: experiments.map((e: any) => ({ approach: e.approach_name, rank: e.rank, hypothesis: e.hypothesis, variables: e.variables, control: e.control, measurement: e.measurement_method, passFail: e.pass_fail_criterion, stop: e.stop_condition, rationale: e.rank_rationale })),
    nullResults: nulls.map((n: any) => ({ subQuestion: n.sub_question_id, note: n.note })),
  };
}

/** Plain, model-free rendering used when the budget or the founder stopped the run before a section could be written. */
export function deterministicSection(s: SectionDef, pack: DataPack, reason: string): string {
  const lines: string[] = [];
  const lbl = (f: any) => `[${f.label}${f.verification !== 'verified' ? `, ${f.verification}` : ''}${f.labelCheck === 'failed' ? ', label not supported by sources' : ''}]`;
  if (s.key === 'problem' && pack.restatement) { const r = pack.restatement as any; lines.push(`${r.statement}`, `Success measure: ${r.success_measure}`, ...(r.corrections ? [`Correction to the original statement: ${r.corrections}`] : [])); }
  else if (/evidence/.test(s.key)) pack.findings.forEach(f => lines.push(`- ${f.claim} ${lbl(f)} ${f.sources.map((x: any) => `[${x.handle}]`).join(' ')}`.trim()));
  else if (/technology|discovery/.test(s.key)) pack.approaches.forEach(a => lines.push(`- ${a.name} (${a.status}${a.industry ? `, from ${a.industry}` : ''}): ${a.summary ?? ''}${a.reason ? ` Reason: ${a.reason}` : ''}`));
  else if (/experiment/.test(s.key)) pack.experiments.forEach(e => lines.push(`- #${e.rank ?? '?'} ${e.approach}: ${e.hypothesis}`));
  else if (/recommend/.test(s.key)) pack.approaches.filter(a => a.rank != null).sort((a, b) => a.rank - b.rank).forEach(a => lines.push(`- #${a.rank} ${a.name} (confidence: ${a.confidence}): ${a.rationale ?? ''}`));
  return `${lines.length ? lines.join('\n') + '\n\n' : ''}_This section was not written by the model: ${reason}._`;
}

export interface ReportOutcome { partial: boolean; sectionsWritten: number; sectionsFallback: number }

/** One model call per template section. Falls back to a model-free rendering when a call cannot be made. */
export async function writeReport(store: PgStore, ctx: RunContext, plan: any, coverage: any, mode: { allowModel: boolean; reason: string | null }): Promise<ReportOutcome> {
  const sections = ctx.promptSet.template.sections ?? [];
  const stage = await store.ensureStage(ctx.inv.id, 'report'); await store.updateStage(stage.id, { status: 'running', started: true });
  const pack = await buildDataPack(store, ctx, plan, coverage);
  const banners: string[] = [];
  if (coverage?.limited) banners.push(`Limited coverage: ${(coverage.reasons as string[]).join('; ')}.`);
  let partial = false; let written = 0; let fallback = 0; let allowModel = mode.allowModel; let reason = mode.reason ?? 'the run stopped early';
  const reportId = await store.createReport(ctx.inv.id, ctx.promptSet.ids.template, false, null);
  const llm = ctx.llm('report', stage.id); const model = ctx.modelRef('report');
  const findingIdsFor = (text: string) => { const hs = new Set(cited(text)); return pack.findings.filter(f => f.sources.some((s: any) => hs.has(s.handle))).map(f => f.id as string); };

  for (const [i, s] of sections.entries()) {
    let content: string | null = null;
    if (allowModel && !(await store.stopRequested(ctx.inv.id))) {
      try {
        const system = `${WRITER_RULES}\n\nSection to write: ${s.title}\nInstruction from the R&D lead: ${s.instruction}${s.max_words ? `\nKeep it within ${s.max_words} words.` : ''}`;
        const user = `DATA PACK (JSON):\n${JSON.stringify(pack)}`;
        let res = await llm.generate({ model, messages: [{ role: 'system', parts: [{ type: 'text', text: system }] }, { role: 'user', parts: [{ type: 'text', text: user }] }], outputSchema: reportSectionSchema, maxOutputTokens: Math.min(model.capabilities.maxOutputTokens, 4_000) });
        let text = String((res.structured as any).content);
        if (s.max_words && countWords(text) > s.max_words * 1.25) {          // one re-ask: the Architect's limit is a requirement
          res = await llm.generate({ model, outputSchema: reportSectionSchema, maxOutputTokens: Math.min(model.capabilities.maxOutputTokens, 4_000),
            messages: [{ role: 'system', parts: [{ type: 'text', text: system }] }, { role: 'user', parts: [{ type: 'text', text: user }] }, { role: 'assistant', parts: [{ type: 'text', text: JSON.stringify({ content: text }) }] },
              { role: 'user', parts: [{ type: 'text', text: `That is ${countWords(text)} words; the limit is ${s.max_words}. Rewrite it shorter, keeping the citations.` }] }] });
          text = String((res.structured as any).content);
        }
        content = text;
      } catch (e) {
        if (e instanceof BudgetStop) { ctx.governor.beginWrapup(); reason = 'the budget was reached'; allowModel = false; }
        else if (e instanceof ProviderError && e.kind !== 'auth') { reason = `the model could not produce this section (${e.kind})`; }
        else throw e;
      }
    }
    if (content === null) { partial = true; fallback++; content = deterministicSection(s, pack, reason); } else written++;
    await store.saveSection(reportId, { key: s.key, position: i + 1, title: s.title, content, findingIds: findingIdsFor(content) });
  }
  if (partial) banners.unshift(`Partial report: ${fallback} of ${sections.length} section(s) were assembled without the model because ${reason}.`);
  await store.updateStage(stage.id, { status: 'done', finished: true });
  await store.setReportMeta(reportId, partial, banners.join(' ') || null);
  return { partial, sectionsWritten: written, sectionsFallback: fallback };
}
