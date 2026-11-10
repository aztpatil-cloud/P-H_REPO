import { BudgetGovernor, resolveBudgetConfig } from '../budget';
import { PriceBook } from '../pricing';
import { mergeRequires, PLATFORM_MINIMUMS, unmetRequirements, type LabelDef, type Requires } from '../prompts/parse';
import type { ModelProvider, ModelRef } from '../providers/types';
import type { SearchSource } from '../sources/types';
import { MeteredProvider } from './metered';
import type { InvestigationRow, LoadedPromptSet, PgStore, Routing } from './store';

export const TASKS_NEEDED = ['stage1_plan', 'stage2_research', 'report'] as const;
export const REPORT_REQUIRES: Requires = { structured_output: true, min_output_tokens: 4_000 };

export class PreflightError extends Error { constructor(readonly problems: string[]) { super(`cannot start: ${problems.join('; ')}`); this.name = 'PreflightError'; } }

export interface SourceSet { searchers: Record<string, SearchSource>; descriptions: Record<string, string> }
export interface RunContext {
  inv: InvestigationRow; promptSet: LoadedPromptSet; routing: Routing; fx: number; governor: BudgetGovernor; priceBook: PriceBook;
  labels: LabelDef[]; sources: SourceSet; now: () => Date;
  modelRef(task: string): ModelRef;
  llm(task: string, runStageId: string | null): MeteredProvider;
}
export interface ContextDeps { store: PgStore; providerFor: (providerKey: string) => ModelProvider; sourcesFor: (inv: InvestigationRow) => SourceSet; now?: () => Date }

export async function buildContext(d: ContextDeps, invId: string): Promise<RunContext> {
  const inv = await d.store.investigation(invId);
  const [promptSet, routing, settings, priceRows] = await Promise.all([d.store.promptSet(inv), d.store.routing(inv), d.store.settings(), d.store.priceRows()]);
  const problems: string[] = [];
  if (settings.fxRateInrPerUsd == null) problems.push('the exchange rate (₹ per US$) is not set');
  let cfg; try { cfg = resolveBudgetConfig(settings, { requestedCapInr: inv.capInr, isTest: inv.isTest }); } catch (e) { problems.push((e as Error).message); }
  if (problems.length || !cfg) throw new PreflightError(problems);
  const priceBook = new PriceBook(priceRows, { requireVerified: true });
  const now = d.now ?? (() => new Date());
  const governor = new BudgetGovernor(cfg, d.store.ledger(inv.id));
  const modelRef = (task: string): ModelRef => { const m = routing[task]?.primary; if (!m) throw new Error(`no model routed for ${task}`); return { registryId: m.id, provider: m.provider, providerModel: m.providerModel, capabilities: m.capabilities }; };
  return {
    inv, promptSet, routing, fx: settings.fxRateInrPerUsd!, governor, priceBook, labels: promptSet.labels.labels ?? [], sources: d.sourcesFor(inv), now, modelRef,
    llm: (task, runStageId) => new MeteredProvider(d.providerFor(modelRef(task).provider) as any, { governor, sink: d.store, priceBook, fxRate: settings.fxRateInrPerUsd!, task, investigationId: inv.id, runStageId, isTest: inv.isTest, now }),
  };
}

/** Everything that can be known before the first model call. Fails at assignment time, never mid-run. */
export function preflight(ctx: RunContext): void {
  const problems: string[] = [];
  const reqs: Record<string, Requires> = {
    stage1_plan: mergeRequires(PLATFORM_MINIMUMS.stage1_plan, ctx.promptSet.stage1.requires),
    stage2_research: mergeRequires(PLATFORM_MINIMUMS.stage2_research, ctx.promptSet.stage2.requires),
    report: REPORT_REQUIRES,
  };
  for (const task of TASKS_NEEDED) {
    const m = ctx.routing[task]?.primary; if (!m) { problems.push(`no model assigned for ${task}`); continue; }
    if (m.status !== 'active') problems.push(`${m.displayName} (${task}) is ${m.status}, not active`);
    const unmet = unmetRequirements(reqs[task]!, m.capabilities); if (unmet.length) problems.push(`${m.displayName} cannot serve ${task}: ${unmet.join(', ')}`);
    if (ctx.inv.confidential && !m.confidentialOk) problems.push(`${m.displayName} (${task}) is not cleared for confidential material: its data policy must be verified within the last 90 days and its conformance check must have passed`);
    try { ctx.priceBook.get(ctx.modelRef(task), ctx.now()); } catch (e) { problems.push(`${m.displayName} (${task}): ${(e as Error).message}`); }
  }
  if (problems.length) throw new PreflightError([...new Set(problems)]);
}
