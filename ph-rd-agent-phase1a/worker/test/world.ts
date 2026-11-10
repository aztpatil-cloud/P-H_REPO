import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { PriceBook } from '../src/pricing';
import type { Db } from '../src/db/sql';
import type { RawResult } from '../src/providers/base';
import { MockProvider } from '../src/providers/mock';
import type { GenerateRequest } from '../src/providers/types';
import { PgStore } from '../src/pipeline/store';
import type { EngineDeps } from '../src/pipeline/engine';
import type { SearchSource, SourceRecord } from '../src/sources/types';
import { freshDb } from './helpers';

export const FOUNDER = '00000000-0000-0000-0000-00000000000f';
export const pgliteDb = (db: PGlite): Db => ({
  query: async (t, p) => (await db.query(t, p as any[])).rows as any[],
  exec: async t => { await db.exec(t); },
  tx: fn => db.transaction(async tx => fn({ query: async (t, p) => (await tx.query(t, p as any[])).rows as any[], exec: async t => { await tx.exec(t); } })),
});

export interface WorldOpts { cap?: number | null; monthly?: number | null; fx?: number | null; modelCleared?: boolean; priceVerified?: boolean; priceIn?: number; priceOut?: number; routes?: boolean }

export async function world(o: WorldOpts = {}) {
  const raw = await freshDb(); const db = pgliteDb(raw); const store = new PgStore(db);
  await raw.exec(readFileSync(join(__dirname, '../../supabase/seed.sql'), 'utf8'));
  await raw.exec(`insert into auth.users values ('${FOUNDER}','f@x.com'); insert into profiles(id,email,role) values ('${FOUNDER}','f@x.com','founder');`);
  const [m] = (await raw.query(`insert into model_registry(provider,provider_model,display_name,status,context_tokens,max_output_tokens,supports_structured_output,supports_tool_calling,trains_on_inputs,data_policy_verified_at,conformance_passed_at)
    values ('mock','mock-model','Mock model','active',1000000,64000,true,true,'no',${o.modelCleared === false ? 'null' : 'now()'},${o.modelCleared === false ? 'null' : 'now()'}) returning id`)).rows as any[];
  await raw.query(`insert into model_prices(model_registry_id,input_usd_per_m,output_usd_per_m,effective_from,verified_at) values ($1,$2,$3,'2026-01-01',${o.priceVerified === false ? 'null' : 'now()'})`, [m.id, o.priceIn ?? 1, o.priceOut ?? 4]);
  if (o.routes !== false) for (const t of ['stage1_plan', 'stage2_research', 'report', 'extraction', 'verification_helper', 'embeddings']) await raw.query(`insert into model_routes(task, primary_model_id) values ($1,$2)`, [t, m.id]);
  await raw.query(`update settings set investigation_cap_inr=$1, monthly_budget_inr=$2, fx_rate_inr_per_usd=$3`, [o.cap === undefined ? 800 : o.cap, o.monthly === undefined ? 10000 : o.monthly, o.fx === undefined ? 90 : o.fx]);
  return { raw, db, store, modelId: m.id as string, priceBook: new PriceBook([{ modelRegistryId: m.id, inputUsdPerM: o.priceIn ?? 1, outputUsdPerM: o.priceOut ?? 4, effectiveFrom: '2026-01-01', verifiedAt: '2026-11-01T00:00:00Z' }]) };
}
export type World = Awaited<ReturnType<typeof world>>;

// ── scripted sources and model ───────────────────────────────────────────────
export const R1: SourceRecord = { sourceType: 'peer_reviewed_paper', doi: '10.1000/r1', url: 'https://journal.example/r1', title: 'Enzymatic sugar reduction in apple juice', abstract: 'Enzymatic treatment reduced sugar content by 30% in apple juice without affecting colour.', retrievedVia: 'openalex', publishedOn: '2021-05-04' };
export const R2: SourceRecord = { sourceType: 'review_article', doi: '10.1000/r2', url: 'https://journal.example/r2', title: 'Review of non-thermal preservation methods', abstract: 'Pulsed electric fields inactivate spoilage microbes in liquid foods at ambient temperature across many studies.', retrievedVia: 'openalex', publishedOn: '2020' };
export const R3: SourceRecord = { sourceType: 'preprint', doi: '10.1000/r3', url: 'https://preprint.example/r3', title: 'Preprint on cold plasma for snack shelf life', abstract: 'Cold plasma treatment extended shelf life of packaged snacks by two weeks in lab trials.', retrievedVia: 'pubmed', publishedOn: '2022-11-07' };
export const ALL = [R1, R2, R3];

export class FakeSource implements SearchSource {
  calls: string[] = [];
  constructor(readonly name: string, private byQuery: Record<string, SourceRecord[] | Error>) {}
  async search(req: { query: string }) { this.calls.push(req.query); const r = this.byQuery[req.query] ?? []; if (r instanceof Error) throw r; return { records: r, cacheHit: false, estimatedCostUsd: 0 }; }
}

export const PLAN = {
  problem_restatement: { statement: 'Extend the shelf life of a fruit-based snack without chemical preservatives.', success_measure: 'Six months at ambient temperature with no spoilage', corrections: null },
  sub_questions: [
    { id: 'q1', question: 'How can microbial growth be limited?', function_restatement: 'Keep a high-sugar paste microbiologically stable', mechanism: 'Spoilage organisms need free water', mechanism_is_assumption: false },
    { id: 'q2', question: 'How can oxidation be slowed?', function_restatement: 'Limit oxygen reaching a lipid-containing matrix', mechanism: 'Oxygen drives lipid oxidation', mechanism_is_assumption: true }],
  search_plan: [
    { sub_question_id: 'q1', source: 'openalex', industry: 'pharmaceuticals', query: 'a', rationale: 'r', is_disconfirming: false },
    { sub_question_id: 'q1', source: 'pubmed', industry: 'food', query: 'b', rationale: 'r', is_disconfirming: true },
    { sub_question_id: 'q2', source: 'openalex', industry: 'packaging', query: 'c', rationale: 'r', is_disconfirming: false }],
  assumptions: ['Ambient storage'], risks: ['Thin literature'],
};

export interface BrainOpts { usage?: { inputTokens: number; outputTokens: number }; badPlanFirst?: boolean; alwaysBadPlan?: boolean; followups?: number; onCall?: (kind: string, n: number) => void | Promise<void> }
const finding = (o: any) => ({ mechanism: null, limitations: 'Abstract only', source_type: 'other', industry_of_origin: 'food', quotes: [], commercial: [], label_rationale: 'rationale', ...o });
const src = (ref: string, t = false, n = false) => ({ ref, reports_test_data: t, names_real_use: n });

export const Q1_OUT = {
  findings: [
    finding({ claim: 'Enzymes cut sugar in juice.', evidence_label: 'established_science', sources: [src('S1', true), src('S2')], source_type: 'preprint', quotes: [{ ref: 'S1', quote: 'reduced sugar content by 30% in apple juice' }],
      commercial: [{ field: 'cost driver', value: '₹5 per kg', unit: 'INR', source_ref: 'S99', status: 'sourced' }] }),
    finding({ claim: 'Cold plasma may extend shelf life.', evidence_label: 'established_science', sources: [src('S3', true)] }),
    finding({ claim: 'A barrier film may help snack packs.', evidence_label: 'our_hypothesis', sources: [], label_rationale: 'Inferred by analogy; test by comparing oxygen transmission.' }),
    finding({ claim: 'Sugar reduction is possible in apple juice.', evidence_label: 'experimental', sources: [src('S1'), src('S77')] })],
  approaches: [
    { name: 'Enzymatic sugar reduction', industry_of_origin: 'food', status: 'kept', summary: 'Use enzymes', reason: null, biggest_weakness: 'Only juice tested',
      ph_fit: { food_safety_regulatory_items_to_verify: ['Enzyme approval'], availability_in_india: null, manufacturing_complexity_and_scalability: null, effect_on_taste_texture_shelf_life: null },
      commercial: [{ field: 'cost per pack', value: '₹0.4', unit: 'INR', source_ref: 'S1', status: 'sourced' }], finding_indexes: [0, 3] },
    { name: 'Cold plasma', industry_of_origin: 'food', status: 'rejected', summary: 'Plasma treatment', reason: 'Only a preprint, lab scale', biggest_weakness: null,
      ph_fit: { food_safety_regulatory_items_to_verify: [], availability_in_india: null, manufacturing_complexity_and_scalability: null, effect_on_taste_texture_shelf_life: null }, commercial: [], finding_indexes: [1] }],
  null_results: [],
};
export const Q2_OUT = { findings: [], approaches: [], null_results: [{ note: 'Searched openalex for packaging barriers; nothing reliable found.' }] };
export const SYNTH = { experiments: [{ approach_name: 'Enzymatic sugar reduction', hypothesis: 'Enzyme dose lowers sugar by 25%', variables: ['dose'], control: 'no enzyme', measurement_method: 'HPLC', pass_fail_criterion: '>=25% reduction', stop_condition: 'taste panel rejects', rank: 1, rank_rationale: 'cheapest' }],
  ranking: [{ approach_name: 'Enzymatic sugar reduction', rank: 1, rationale: 'best supported', confidence: 'high', uncertainty_note: 'one matrix only', biggest_weakness: 'juice only', next_step: 'bench trial' }] };

export function brain(o: BrainOpts = {}) {
  const usage = o.usage ?? { inputTokens: 4000, outputTokens: 800 }; let n = 0; let planCalls = 0; const toolRounds: Record<string, number> = {};
  const fn = (req: GenerateRequest): RawResult => {
    n++; const props = (req.outputSchema as any)?.properties ?? {}; const first = JSON.stringify(req.messages.find(m => m.role === 'user')?.parts ?? '');
    const out = (obj: unknown): RawResult => ({ text: JSON.stringify(obj), toolCalls: [], finishReason: 'stop', usage });
    const kind = props.problem_restatement ? 'stage1' : props.findings ? 'extract' : props.experiments ? 'synthesis' : props.content ? 'report' : req.tools ? 'toolloop' : 'other';
    void o.onCall?.(kind, n);
    if (kind === 'stage1') { planCalls++;
      if (o.alwaysBadPlan || (o.badPlanFirst && planCalls === 1)) return out({ ...PLAN, search_plan: [{ ...PLAN.search_plan[0], sub_question_id: 'zzz' }] });
      return out(PLAN); }
    if (kind === 'toolloop') { const sq = /Sub-question (q\d+)/.exec(first)?.[1] ?? '?'; const r = (toolRounds[sq] = (toolRounds[sq] ?? 0) + 1);
      if (o.followups && sq === 'q1' && r === 1) return { toolCalls: Array.from({ length: o.followups }, (_, i) => ({ id: `t${i}`, name: 'search_sources', args: { source: 'pubmed', query: `extra${i}`, reason: 'look wider' } })), finishReason: 'tool_calls', usage };
      return { text: 'DONE', toolCalls: [], finishReason: 'stop', usage }; }
    if (kind === 'extract') return out(/Sub-question q1/.test(first) ? Q1_OUT : Q2_OUT);
    if (kind === 'synthesis') return out(SYNTH);
    if (kind === 'report') { const title = /Section to write: (.*)/.exec(JSON.stringify(req.messages[0]!.parts).replace(/\\n/g, '\n'))?.[1]?.replace(/".*$/, '') ?? 'section'; return out({ content: `Written section ${title} citing [S1].` }); }
    return { text: 'ok', toolCalls: [], finishReason: 'stop', usage };
  };
  return fn;
}

export function engineDeps(w: World, o: { brain?: BrainOpts; sources?: Record<string, SearchSource>; followups?: number } = {}) {
  const provider = new MockProvider(w.priceBook, brain(o.brain));
  const openalex = new FakeSource('openalex', { a: [R1, R2], c: [] }); const pubmed = new FakeSource('pubmed', { b: [R2, R3], extra0: [R3], extra1: [R1] });
  const searchers = o.sources ?? { openalex, pubmed };
  const byDoi: Record<string, SourceRecord> = Object.fromEntries(ALL.map(r => [r.doi!, r]));
  const deps: EngineDeps = {
    store: w.store, providerFor: () => provider, now: () => new Date('2026-11-09T00:00:00Z'),
    sourcesFor: () => ({ searchers, descriptions: { openalex: 'scholarly works across all disciplines', pubmed: 'biomedical and life-science literature' } }),
    doiResolver: { name: 'fake', lookupDoi: async d => byDoi[d] ?? null },
    urlDeps: { fetch: (async () => new Response('<title>x</title>', { headers: { 'content-type': 'text/html' } })) as any, resolveHost: async () => ['93.184.216.34'] },
    followupsPerSubQuestion: o.followups,
  };
  return { deps, provider, openalex, pubmed };
}
