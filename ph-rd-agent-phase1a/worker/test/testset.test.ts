import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dimensionApplies, parseTestSet, weightedScore } from '../src/testset/parse';

const real = readFileSync(join(__dirname, '../../prompts/seed/test_set_v1.yaml'), 'utf8');
const mk = (rubric: string, cases: string) => `schema_version: 1\nname: t\nrubric:\n${rubric}\ncases:\n${cases}`;
const dim = '  - {key: a, name: A, description: d, scale: {min: 0, max: 4}}';
const kase = '  - {key: c1, title: T, problem: P}';
const codes = (y: string) => parseTestSet(y).errors.map(e => e.code);

describe("the Architect's test_set_v1.yaml", () => {
  const r = parseTestSet(real);
  it('is accepted with no errors or warnings: 8 dimensions, 6 confidential cases', () => {
    expect(r.errors).toEqual([]); expect(r.warnings).toEqual([]);
    expect(r.parsed!.rubric).toHaveLength(8); expect(r.parsed!.cases).toHaveLength(6); expect(r.parsed!.cases.every(c => c.confidential)).toBe(true);
    expect(r.parsed!.rubric.find(d => d.key === 'evidence_honesty')!.weight).toBe(1.5);
  });
  it('keeps expected_notes separate from the problem text that is sent to models', () => {
    const c = r.parsed!.cases[0]!; expect(c.problem).not.toContain('Reference directions'); expect(c.expected_notes).toContain('Reference directions');
  });
});

describe('not-applicable scoring (premise_challenge is case_06 only)', () => {
  const rubric = parseTestSet(real).parsed!.rubric;
  const base = { problem_framing: 4, mechanism: 4, cross_industry_reach: 4, evidence_honesty: 4, fit_for_ph_india: 4, experiments: 4, calibration: 4 };
  it('null on a non-applicable dimension is left out of the total, so the case is not penalised', () => {
    expect(weightedScore({ ...base, premise_challenge: null }, rubric, 'case_01')).toBe(100);
    expect(weightedScore(base, rubric, 'case_01')).toBe(100);                                  // missing is also N/A
  });
  it('on case_06 the premise_challenge score counts', () => {
    expect(weightedScore({ ...base, premise_challenge: 0 }, rubric, 'case_06')).toBeCloseTo((7.5 * 4) / (8.5 * 4) * 100, 5);
  });
  it('weights apply (evidence_honesty counts 1.5x) and out-of-range scores are rejected', () => {
    expect(weightedScore({ ...base, evidence_honesty: 0 }, rubric, 'case_01')).toBeCloseTo(((7.5 - 1.5) * 4) / (7.5 * 4) * 100, 5);
    expect(() => weightedScore({ ...base, mechanism: 5 }, rubric, 'case_01')).toThrow(/outside/);
    expect(weightedScore({}, rubric, 'case_01')).toBeNull();
  });
  it('optional applies_to makes case_06-only strict: scores on other cases are ignored', () => {
    const strict = rubric.map(d => d.key === 'premise_challenge' ? { ...d, applies_to: ['case_06'] } : d);
    expect(dimensionApplies(strict.find(d => d.key === 'premise_challenge')!, 'case_01')).toBe(false);
    expect(weightedScore({ ...base, premise_challenge: 0 }, strict, 'case_01')).toBe(100);
    expect(weightedScore({ ...base, premise_challenge: 0 }, strict, 'case_06')).toBeLessThan(100);
  });
});

describe('importer rules', () => {
  it('rejects duplicate keys, bad keys, bad scales, anchors outside the scale, weights, missing fields', () => {
    expect(codes(mk(`${dim}\n${dim}`, kase))).toContain('duplicate_key');
    expect(codes(mk('  - {key: Bad Key, name: A, description: d, scale: {min: 0, max: 4}}', kase))).toContain('bad_key');
    expect(codes(mk('  - {key: a, name: A, description: d, scale: {min: 4, max: 4}}', kase))).toContain('bad_scale');
    expect(codes(mk('  - {key: a, name: A, description: d, scale: {min: 0, max: 4}, anchors: {9: x}}', kase))).toContain('bad_anchors');
    expect(codes(mk('  - {key: a, name: A, description: d, scale: {min: 0, max: 4}, weight: 0}', kase))).toContain('bad_weight');
    expect(codes(mk(dim, '  - {key: c1, title: T}'))).toContain('bad_case');
    expect(codes('schema_version: 2\nname: t\nrubric: []\ncases: []')).toEqual(expect.arrayContaining(['schema_version', 'no_rubric', 'no_cases']));
    expect(codes('::: not yaml')).toBeTruthy();
  });
  it('applies_to must reference real cases; unknown fields only warn', () => {
    expect(codes(mk('  - {key: a, name: A, description: d, scale: {min: 0, max: 4}, applies_to: [nope]}', kase))).toContain('bad_applies_to');
    const w = parseTestSet(mk('  - {key: a, name: A, description: d, scale: {min: 0, max: 4}, colour: red}', kase));
    expect(w.ok).toBe(true); expect(w.warnings.map(x => x.code)).toEqual(['unknown_field']);
  });
  it('reference_plan is validated against the stage 1 plan shape', () => {
    expect(codes(mk(dim, '  - {key: c1, title: T, problem: P, reference_plan: {sub_questions: []}}'))).toContain('bad_reference_plan');
  });
});
