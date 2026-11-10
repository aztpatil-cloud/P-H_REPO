// Platform-owned output schemas. The Architect's prompt files describe METHOD only ("do not describe an
// output format"); these schemas are what the model must return. Provider-neutral JSON-Schema subset.
import type { JsonSchema } from '../providers/types';

export const SOURCE_TYPES = ['peer_reviewed_paper', 'review_article', 'preprint', 'patent', 'technical_report', 'standard_regulatory', 'company_web', 'trade_press', 'internal_doc', 'other'] as const;

const str = (description?: string): JsonSchema => ({ type: 'string', ...(description ? { description } : {}) });
const nstr = (description?: string): JsonSchema => ({ ...str(description), nullable: true });
const strs = (description?: string): JsonSchema => ({ type: 'array', items: str(), ...(description ? { description } : {}) });
const obj = (properties: Record<string, JsonSchema>, description?: string): JsonSchema =>
  ({ type: 'object', properties, required: Object.keys(properties), ...(description ? { description } : {}) });

// ── Stage 1: plan ──────────────────────────────────────────────────────────────
export function stage1PlanSchema(sourceNames?: string[]): JsonSchema {
  const source: JsonSchema = sourceNames?.length ? { type: 'string', enum: sourceNames, description: 'one of the available sources' } : str('one of the available sources');
  return obj({
    problem_restatement: obj({
      statement: str('the problem in one sentence'),
      success_measure: str('what success would look like in measurable terms'),
      corrections: nstr('how the original statement was corrected and why; null if no correction was needed'),
    }),
    sub_questions: { type: 'array', items: obj({
      id: str('short identifier such as q1'),
      question: str(),
      function_restatement: str('the question restated as a function in neutral technical language'),
      mechanism: str('the believed underlying mechanism'),
      mechanism_is_assumption: { type: 'boolean', description: 'true if the mechanism is an unconfirmed assumption' },
    }) },
    search_plan: { type: 'array', items: obj({
      sub_question_id: str(),
      source,
      industry: str('industry whose vocabulary the query uses'),
      query: str(),
      rationale: str('one line: what it could reveal and why it matters'),
      is_disconfirming: { type: 'boolean', description: 'true if aimed at failures, limits or disconfirming evidence' },
    }) },
    assumptions: strs(),
    risks: strs(),
  });
}

// ── Stage 2: per sub-question result ───────────────────────────────────────────
const commercialItem = obj({
  field: str('what the figure is, e.g. cost driver or price'),
  value: nstr('the figure exactly as stated by the source; null if not estimated'),
  unit: nstr(),
  source_ref: nstr('identifier of the retrieved source; null if not estimated'),
  status: { type: 'string', enum: ['sourced', 'not_estimated'] },
}, 'a commercial figure needs a retrieved source; otherwise status is not_estimated with null value and source_ref');

export function stage2SubQuestionSchema(labelKeys: string[]): JsonSchema {
  return obj({
    findings: { type: 'array', items: obj({
      claim: str('one claim per finding'),
      evidence_label: { type: 'string', enum: labelKeys },
      label_rationale: str('short rationale tied to the specific source'),
      mechanism: nstr('how it works'),
      limitations: nstr('stated limits, including when only an abstract was seen'),
      source_type: { type: 'string', enum: [...SOURCE_TYPES] },
      industry_of_origin: str(),
      sources: { type: 'array', description: 'retrieved sources supporting the claim; empty only for a claim with no sources such as a hypothesis', items: obj({
        ref: str('identifier of the retrieved source'),
        reports_test_data: { type: 'boolean', description: 'true only if this source itself reports test data or results for the claim' },
        names_real_use: { type: 'boolean', description: 'true only if this source names a specific real product, process or user of the approach' },
      }) },
      quotes: { type: 'array', items: obj({ ref: str(), quote: str('short text that appears in the retrieved material') }) },
      commercial: { type: 'array', items: commercialItem },
    }) },
    approaches: { type: 'array', items: obj({
      name: str(),
      industry_of_origin: str(),
      status: { type: 'string', enum: ['kept', 'rejected', 'inconclusive'] },
      summary: str(),
      reason: nstr('reason for rejecting or for being inconclusive'),
      biggest_weakness: nstr('required for kept approaches'),
      ph_fit: obj({
        food_safety_regulatory_items_to_verify: strs(),
        availability_in_india: nstr(),
        manufacturing_complexity_and_scalability: nstr(),
        effect_on_taste_texture_shelf_life: nstr(),
      }),
      commercial: { type: 'array', items: commercialItem },
      finding_indexes: { type: 'array', items: { type: 'integer' }, description: 'positions in findings[] that support this approach' },
    }) },
    null_results: { type: 'array', items: obj({ note: str('what was searched and why nothing reliable was found') }) },
  });
}

// ── Stage 2: synthesis across the whole investigation ──────────────────────────
export const synthesisSchema: JsonSchema = obj({
  experiments: { type: 'array', items: obj({
    approach_name: str(),
    hypothesis: str(), variables: strs(), control: str(), measurement_method: str(),
    pass_fail_criterion: str(), stop_condition: str(),
    rank: { type: 'integer' }, rank_rationale: str(),
  }) },
  ranking: { type: 'array', items: obj({
    approach_name: str(), rank: { type: 'integer' }, rationale: str(),
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    uncertainty_note: str(), biggest_weakness: str(), next_step: str(),
  }) },
});

// ── Report: one call per template section ──────────────────────────────────────
export const reportSectionSchema: JsonSchema = obj({ content: str('the section text in plain markdown') });

// TypeScript views of the same shapes
export interface Stage1Plan {
  problem_restatement: { statement: string; success_measure: string; corrections: string | null };
  sub_questions: Array<{ id: string; question: string; function_restatement: string; mechanism: string; mechanism_is_assumption: boolean }>;
  search_plan: Array<{ sub_question_id: string; source: string; industry: string; query: string; rationale: string; is_disconfirming: boolean }>;
  assumptions: string[]; risks: string[];
}
