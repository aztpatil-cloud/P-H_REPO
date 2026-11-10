import type { LabelDef } from '../prompts/parse';

export function renderLabelDefinitions(labels: LabelDef[]): string {
  return labels.map(l => [
    `- ${l.name} (key: ${l.key})`,
    `  Definition: ${l.definition}`,
    l.criteria ? `  Criteria: ${l.criteria}` : null,
    ...(l.examples ?? []).map(e => `  Example: ${e}`),
  ].filter(Boolean).join('\n')).join('\n');
}

export function renderAvailableSources(sources: Array<{ name: string; description: string }>): string {
  return sources.length ? sources.map(s => `- ${s.name}: ${s.description}`).join('\n') : 'none';
}

const list = (v: string[]) => (v.length ? v.join(', ') : 'none specified');

export interface Stage1Context {
  problem: string; industriesInclude: string[]; industriesExclude: string[];
  sources: Array<{ name: string; description: string }>; labels: LabelDef[]; today: Date;
}
export function stage1Variables(c: Stage1Context): Record<string, string> {
  return {
    today: c.today.toISOString().slice(0, 10), problem: c.problem,
    industries_include: list(c.industriesInclude), industries_exclude: list(c.industriesExclude),
    available_sources: renderAvailableSources(c.sources), label_definitions: renderLabelDefinitions(c.labels),
  };
}

export interface Stage2Context extends Omit<Stage1Context, 'industriesInclude' | 'industriesExclude'> {
  approvedPlan: unknown; capInr: number; spentInr: number;
}
export function stage2Variables(c: Stage2Context): Record<string, string> {
  const remaining = Math.max(0, c.capInr - c.spentInr);
  return {
    today: c.today.toISOString().slice(0, 10), problem: c.problem,
    approved_plan: JSON.stringify(c.approvedPlan, null, 2),
    available_sources: renderAvailableSources(c.sources), label_definitions: renderLabelDefinitions(c.labels),
    budget_note: `Hard cap for this investigation: ₹${c.capInr.toFixed(0)}; about ₹${remaining.toFixed(0)} remains. Research stops automatically when the budget is reached and everything found so far is kept.`,
  };
}
