import type { PriceBook } from '../pricing';
import { usdToInr, costUsd } from '../pricing';
import type { ModelRef } from '../providers/types';
import type { Stage1Plan } from './schemas';

export const MAX_SUB_QUESTIONS = 12;
export const planKey = (sq: string, source: string, query: string) => `${sq}|${source}|${query.trim().toLowerCase()}`;

/** Structural checks the model's plan (and the founder's edits to it) must satisfy before research may start. */
export function checkPlan(plan: Stage1Plan, availableSources: string[], maxItems: number): string[] {
  const p: string[] = [];
  if (!plan.sub_questions?.length) p.push('the plan has no sub-questions');
  if (plan.sub_questions.length > MAX_SUB_QUESTIONS) p.push(`too many sub-questions (${plan.sub_questions.length}; maximum ${MAX_SUB_QUESTIONS})`);
  const ids = new Set<string>();
  for (const q of plan.sub_questions) { if (ids.has(q.id)) p.push(`duplicate sub-question id "${q.id}"`); ids.add(q.id); if (!q.question.trim()) p.push(`sub-question ${q.id} is empty`); }
  if (!plan.search_plan?.length) p.push('the search plan is empty');
  if (plan.search_plan.length > maxItems) p.push(`too many planned searches (${plan.search_plan.length}; maximum ${maxItems})`);
  const seen = new Set<string>(); const covered = new Set<string>();
  for (const s of plan.search_plan) {
    if (!ids.has(s.sub_question_id)) p.push(`a search refers to unknown sub-question "${s.sub_question_id}"`); else covered.add(s.sub_question_id);
    if (!availableSources.includes(s.source)) p.push(`"${s.source}" is not an available source`);
    if (!s.query.trim()) p.push(`an empty query under ${s.sub_question_id}`);
    const k = planKey(s.sub_question_id, s.source, s.query); if (seen.has(k)) p.push(`duplicate search under ${s.sub_question_id}: "${s.query}"`); seen.add(k);
  }
  for (const id of ids) if (!covered.has(id)) p.push(`sub-question ${id} has no searches`);
  return p;
}

/** Heuristic cost range for the approval screen. Token volumes are assumptions, not measurements. */
export function estimateResearchCostInr(plan: Stage1Plan, model: ModelRef, priceBook: PriceBook, fx: number, at = new Date(), reportSections = 9) {
  const price = priceBook.get(model, at); const n = plan.sub_questions.length;
  const tokens = { input: n * 75_000 + 25_000 + reportSections * 25_000, output: n * 14_000 + 6_000 + reportSections * 1_500 };
  const expected = usdToInr(costUsd({ inputTokens: tokens.input, outputTokens: tokens.output }, price), fx);
  return { lowInr: Math.round(expected * 0.5), expectedInr: Math.round(expected), highInr: Math.round(expected * 1.5), assumptions: `${n} sub-question(s); about ${Math.round(tokens.input / 1000)}k input and ${Math.round(tokens.output / 1000)}k output tokens in total` };
}
