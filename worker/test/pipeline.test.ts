import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSchemaSubset, validateAgainstSchema } from '../src/providers/schema';
import { reportSectionSchema, stage1PlanSchema, stage2SubQuestionSchema, synthesisSchema } from '../src/pipeline/schemas';
import { renderLabelDefinitions, stage1Variables, stage2Variables } from '../src/pipeline/variables';
import { parsePromptFile, renderPrompt } from '../src/prompts/parse';
import { buildSeedSql } from '../src/seed/build-seed';
import { freshDb } from './helpers';

const v1 = (f: string) => readFileSync(join(__dirname, '../../prompts/seed', f), 'utf8');
const LABELS = ['established_science', 'demonstrated_commercial_use', 'experimental', 'theoretical', 'our_hypothesis'];

describe('output schemas', () => {
  it('all fit the provider-neutral subset every adapter can translate', () => {
    for (const s of [stage1PlanSchema(['openalex', 'pubmed']), stage2SubQuestionSchema(LABELS), synthesisSchema, reportSectionSchema]) expect(() => assertSchemaSubset(s)).not.toThrow();
  });

  const plan = { problem_restatement: { statement: 'Extend ketchup shelf life without chemical preservatives.', success_measure: '12 months at 25C with no spoilage', corrections: null },
    sub_questions: [{ id: 'q1', question: 'Microbial growth', function_restatement: 'Keep a water-rich acidic paste microbiologically stable', mechanism: 'Spoilage organisms need water and nutrients', mechanism_is_assumption: false }],
    search_plan: [{ sub_question_id: 'q1', source: 'openalex', industry: 'pharmaceuticals', query: 'preservative-free multidose formulation stability', rationale: 'Pharma solves microbial control without preservatives', is_disconfirming: false },
      { sub_question_id: 'q1', source: 'pubmed', industry: 'food', query: 'limits of hurdle technology failure', rationale: 'Look for failures', is_disconfirming: true }],
    assumptions: ['Target is ambient storage'], risks: ['Sparse literature'] };

  it('stage 1: a good plan validates; unavailable sources and missing fields are rejected', () => {
    const s = stage1PlanSchema(['openalex', 'pubmed']);
    expect(validateAgainstSchema(plan, s)).toEqual([]);
    expect(validateAgainstSchema({ ...plan, search_plan: [{ ...plan.search_plan[0], source: 'patents' }] }, s).join()).toMatch(/allowed values/);
    const { risks, ...noRisks } = plan; expect(validateAgainstSchema(noRisks, s).join()).toMatch(/risks: required/);
  });

  it('stage 1 can express a premise correction (case_06 style) and an uncorrected statement', () => {
    const s = stage1PlanSchema();
    expect(validateAgainstSchema({ ...plan, problem_restatement: { ...plan.problem_restatement, corrections: 'The premise is probably unachievable as stated; reframed into sub-problems.' } }, s)).toEqual([]);
  });

  it('stage 2 can represent what the Architect instructions require: null results, rejected approaches, hypotheses, not-estimated costs', () => {
    const s = stage2SubQuestionSchema(LABELS);
    const out = {
      findings: [
        { claim: 'Encapsulated antioxidant reduced oxidation in one matrix.', evidence_label: 'experimental', label_rationale: 'Single lab-scale study.', mechanism: 'Slows lipid oxidation', limitations: 'Abstract only; one matrix',
          source_type: 'peer_reviewed_paper', industry_of_origin: 'food', sources: [{ ref: 'S1', reports_test_data: true, names_real_use: false }], quotes: [{ ref: 'S1', quote: 'reduced oxidation by 30% in the treated samples' }],
          commercial: [{ field: 'cost driver', value: null, unit: null, source_ref: null, status: 'not_estimated' }] },
        { claim: 'A medical-packaging barrier may extend snack shelf life.', evidence_label: 'our_hypothesis', label_rationale: 'Inferred by analogy; test by comparing O2 transmission.', mechanism: null, limitations: null,
          source_type: 'other', industry_of_origin: 'medical technology', sources: [], quotes: [], commercial: [] }],
      approaches: [{ name: 'Barrier film', industry_of_origin: 'medical technology', status: 'rejected', summary: 'High-barrier laminate', reason: 'Cost per pack too high at target price', biggest_weakness: null,
        ph_fit: { food_safety_regulatory_items_to_verify: ['Food-contact approval'], availability_in_india: null, manufacturing_complexity_and_scalability: null, effect_on_taste_texture_shelf_life: null },
        commercial: [{ field: 'cost per pack effect', value: '₹0.4 per pack', unit: 'INR', source_ref: 'S2', status: 'sourced' }], finding_indexes: [0] }],
      null_results: [{ note: 'Searched two sources for X; nothing reliable found.' }] };
    expect(validateAgainstSchema(out, s)).toEqual([]);
    expect(validateAgainstSchema({ ...out, findings: [{ ...out.findings[0], evidence_label: 'proven_fact' }] }, s).join()).toMatch(/allowed values/);
    expect(validateAgainstSchema({ ...out, null_results: [] , approaches: [], findings: [] }, s)).toEqual([]);   // an honest empty result is valid
  });

  it('synthesis carries experiments with every field the Architect lists, plus ranking with confidence', () => {
    const ok = { experiments: [{ approach_name: 'A', hypothesis: 'h', variables: ['v'], control: 'c', measurement_method: 'm', pass_fail_criterion: 'p', stop_condition: 's', rank: 1, rank_rationale: 'r' }],
      ranking: [{ approach_name: 'A', rank: 1, rationale: 'r', confidence: 'low', uncertainty_note: 'u', biggest_weakness: 'w', next_step: 'n' }] };
    expect(validateAgainstSchema(ok, synthesisSchema)).toEqual([]);
    expect(validateAgainstSchema({ ...ok, ranking: [{ ...ok.ranking[0], confidence: 'certain' }] }, synthesisSchema).join()).toMatch(/allowed values/);
  });
});

describe("the Architect's v1 files", () => {
  it('all four validate with ZERO errors and ZERO warnings', () => {
    for (const k of ['stage1_plan', 'stage2_research', 'report_template', 'evidence_labels'] as const) {
      const r = parsePromptFile(v1(`${k}.md`), k); expect(r.errors, k).toEqual([]); expect(r.warnings, k).toEqual([]);
    }
  });
  it('every variable the Architect uses is supplied by the platform, so a stage prompt renders without gaps', () => {
    const labels = parsePromptFile(v1('evidence_labels.md')).parsed!.labels!;
    const sources = [{ name: 'openalex', description: 'scholarly works' }, { name: 'pubmed', description: 'biomedical literature' }];
    const s1 = renderPrompt(parsePromptFile(v1('stage1_plan.md')).parsed!.body, stage1Variables({ problem: 'P', industriesInclude: [], industriesExclude: ['defence'], sources, labels, today: new Date('2026-11-08') }));
    expect(s1).toContain('Today\'s date: 2026-11-08'); expect(s1).toContain('Industries the founder wants included: none specified'); expect(s1).toContain('defence');
    expect(s1).toContain('(key: established_science)'); expect(s1).not.toContain('{{');
    const s2 = renderPrompt(parsePromptFile(v1('stage2_research.md')).parsed!.body, stage2Variables({ problem: 'P', approvedPlan: { a: 1 }, sources, labels, today: new Date('2026-11-08'), capInr: 800, spentInr: 100 }));
    expect(s2).toContain('₹700 remains'); expect(s2).not.toContain('{{');
  });
  it('label rendering includes the key, definition, criteria and examples the model needs to apply the caps', () => {
    const t = renderLabelDefinitions(parsePromptFile(v1('evidence_labels.md')).parsed!.labels!);
    expect(t).toContain('A patent without test data is Theoretical'); expect(t).toContain('Definition:'); expect(t).toContain('Example:');
  });
  it('the report template keeps all nine sections in order with the Architect word limits', () => {
    const s = parsePromptFile(v1('report_template.md')).parsed!.sections!;
    expect(s.map(x => x.key)).toEqual(['problem', 'mechanism', 'technology_discovery', 'evidence', 'technical_evaluation', 'ph_application', 'commercial_feasibility', 'experiment_proposal', 'recommendation']);
    expect(s.filter(x => x.max_words).map(x => `${x.key}:${x.max_words}`)).toEqual(['problem:150', 'mechanism:400', 'technology_discovery:600', 'recommendation:400']);
  });
});

describe('seeding', () => {
  const files = () => ({ stage1_plan: v1('stage1_plan.md'), stage2_research: v1('stage2_research.md'), report_template: v1('report_template.md'), evidence_labels: v1('evidence_labels.md') });
  it('supabase/seed.sql is up to date with prompts/seed', () => {
    expect(readFileSync(join(__dirname, '../../supabase/seed.sql'), 'utf8')).toBe(buildSeedSql(files()));
  });
  it('refuses to seed a file with errors or warnings (placeholders cannot be seeded)', () => {
    const ph = (f: string) => readFileSync(join(__dirname, 'fixtures/placeholder-prompts', f), 'utf8');
    expect(() => buildSeedSql({ ...files(), stage1_plan: ph('stage1_plan.md') })).toThrow(/warnings/);
  });
  it('applies cleanly: four active v1 versions, five labels, audit entry, and a finding can use a seeded label', async () => {
    const db = await freshDb();
    await db.exec(readFileSync(join(__dirname, '../../supabase/seed.sql'), 'utf8'));
    const v = (await db.query(`select kind, version, status from prompt_versions order by kind`)).rows as any[];
    expect(v.map(r => `${r.kind}:${r.version}:${r.status}`)).toEqual(['evidence_labels:1:active', 'report_template:1:active', 'stage1_plan:1:active', 'stage2_research:1:active']);
    expect(((await db.query(`select count(*)::int c from evidence_labels`)).rows[0] as any).c).toBe(5);
    expect(((await db.query(`select count(*)::int c from audit_log where action='prompts_seeded'`)).rows[0] as any).c).toBe(1);
    await db.exec(`insert into investigations(title,problem,cap_inr) values ('t','p',800);
      insert into findings(investigation_id,sub_question_id,claim,evidence_label,label_set_id,source_type)
        select (select id from investigations),'q1','c','theoretical',(select id from prompt_versions where kind='evidence_labels'),'patent'`);
  });
  it('approach commercial figures follow the same sourced-or-not-estimated rule', async () => {
    const db = await freshDb();
    await db.exec(`insert into investigations(title,problem,cap_inr) values ('t','p',800);
      insert into approaches(investigation_id,name,status) select id,'A','rejected' from investigations;`);
    const id = ((await db.query('select id from approaches')).rows[0] as any).id;
    await expect(db.query(`insert into approach_commercial(approach_id,field,value,status) values ('${id}','cost','5','sourced')`)).rejects.toThrow();
    await expect(db.query(`insert into approach_commercial(approach_id,field,value,status) values ('${id}','cost','5','not_estimated')`)).rejects.toThrow();
    await db.query(`insert into approach_commercial(approach_id,field,status) values ('${id}','cost','not_estimated')`);
    await expect(db.query(`insert into approaches(investigation_id,name,status) select id,'B','proven' from investigations`)).rejects.toThrow();
  });
});
