import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePromptFile } from '../src/prompts/parse';
import { evaluateLabelRules, strongestSupported, type CitedSource } from '../src/prompts/label-rules';

const src = (o: Partial<CitedSource> & { handle: string; sourceType: string }): CitedSource => ({ verification: 'verified', reportsTestData: null, namesRealUse: null, hasVerifiedQuote: false, ...o });
const labelsFile = (body: string) => `---\nkind: evidence_labels\nname: t\n---\n${body}`;

// The EXAMPLE sent to the Architect (not their file): encodes the caps in THEIR criteria text, with the
// two points that are ambiguous in that text called out in the message that accompanies it.
const EXAMPLE = labelsFile(`labels:
  - key: established_science
    name: Established science
    definition: d
    strength: 3
    rules:
      any_of:
        - {min_sources: 2, source_types: [peer_reviewed_paper, review_article, technical_report, standard_regulatory]}
        - {min_sources: 1, source_types: [review_article, standard_regulatory]}
  - key: demonstrated_commercial_use
    name: Demonstrated commercial use
    definition: d
    rules:
      any_of:
        - {min_sources: 1, source_types: [company_web, trade_press, technical_report, standard_regulatory]}
  - key: experimental
    name: Experimental
    definition: d
    strength: 2
    rules:
      any_of:
        - {min_sources: 1, source_types: [peer_reviewed_paper, review_article, technical_report, preprint, company_web, trade_press]}
        - {min_sources: 1, source_types: [patent], requires_test_data: true}
  - key: theoretical
    name: Theoretical
    definition: d
    strength: 1
    rules:
      any_of:
        - {min_sources: 1}
  - key: our_hypothesis
    name: Our hypothesis
    definition: d
    rules:
      allow_no_sources: true
`);
const labels = () => parsePromptFile(EXAMPLE).parsed!.labels!;
const rules = (k: string) => labels().find(l => l.key === k)!.rules;

describe('structured label rules: parsing', () => {
  it('the example validates and keeps rules and strengths', () => {
    const r = parsePromptFile(EXAMPLE); expect(r.errors).toEqual([]); expect(r.warnings).toEqual([]);
    expect(labels().find(l => l.key === 'established_science')!.strength).toBe(3);
  });
  it("a labels file without any rules (the Architect's original v1) still validates with no warnings, and is simply unchecked", () => {
    const r = parsePromptFile(readFileSync(join(__dirname, 'fixtures/labels-without-rules.md'), 'utf8'));
    expect(r.errors).toEqual([]); expect(r.warnings).toEqual([]);
    expect(evaluateLabelRules(r.parsed!.labels![0]!.rules, [])).toEqual({ ok: true });
  });
  it('rejects bad rules: unknown source types, bad min_sources, wrong shapes, bad strength', () => {
    const e = (body: string) => parsePromptFile(labelsFile(body)).errors.map(x => x.code);
    expect(e('labels:\n  - {key: a, name: A, definition: d, rules: {any_of: [{min_sources: 1, source_types: [blog]}]}}')).toContain('bad_rules');
    expect(e('labels:\n  - {key: a, name: A, definition: d, rules: {any_of: [{min_sources: 0}]}}')).toContain('bad_rules');
    expect(e('labels:\n  - {key: a, name: A, definition: d, rules: {any_of: []}}')).toContain('bad_rules');
    expect(e('labels:\n  - {key: a, name: A, definition: d, rules: oops}')).toContain('bad_rules');
    expect(e('labels:\n  - {key: a, name: A, definition: d, strength: -1}')).toContain('bad_label');
    expect(e('labels:\n  - {key: a, name: A, definition: d, strength: 0}')).toEqual([]);                   // 0 is allowed (lowest)
  });
  it('unknown fields only warn', () => {
    const r = parsePromptFile(labelsFile('labels:\n  - {key: a, name: A, definition: d, colour: red, rules: {note: x}}'));
    expect(r.ok).toBe(true); expect(r.warnings.map(w => w.code)).toEqual(['unknown_field', 'unknown_field']);
  });
});

describe('named-use flag', () => {
  const tightened = labelsFile(`labels:
  - key: demonstrated_commercial_use
    name: Demonstrated commercial use
    definition: d
    rules:
      any_of:
        - {min_sources: 1, source_types: [company_web, trade_press, technical_report, standard_regulatory, peer_reviewed_paper], requires_named_use: true}
      allow_no_sources: false
`);
  const r = () => parsePromptFile(tightened).parsed!.labels![0]!.rules;
  const web = (o = {}) => src({ handle: 'S1', sourceType: 'company_web', ...o });
  it('parses requires_named_use and rejects non-boolean values', () => {
    expect(parsePromptFile(tightened).errors).toEqual([]);
    expect(parsePromptFile(tightened.replace('requires_named_use: true', 'requires_named_use: maybe')).errors.map(e => e.code)).toContain('bad_rules');
  });
  it('counts only when the model asserts it AND a quote from that same source verified', () => {
    expect(evaluateLabelRules(r(), [web()]).ok).toBe(false);
    expect(evaluateLabelRules(r(), [web({ namesRealUse: true })]).ok).toBe(false);                      // asserted, no verified quote
    expect(evaluateLabelRules(r(), [web({ namesRealUse: true, hasVerifiedQuote: true })]).ok).toBe(true);
    expect(evaluateLabelRules(r(), [web({ namesRealUse: true, hasVerifiedQuote: true, verification: 'failed' })]).ok).toBe(false);
    expect(evaluateLabelRules(r(), [web({ namesRealUse: true, hasVerifiedQuote: true })]).ok).toBe(true);
    expect(evaluateLabelRules(r(), [web()]).reason).toContain('naming a real use');
  });
});

describe('structured label rules: evaluation', () => {
  const paper = (h: string, o = {}) => src({ handle: h, sourceType: 'peer_reviewed_paper', ...o });
  it('established science: two papers pass, one paper fails, one review passes, a patent+preprint pair fails', () => {
    const r = rules('established_science');
    expect(evaluateLabelRules(r, [paper('S1'), paper('S2')]).ok).toBe(true);
    expect(evaluateLabelRules(r, [paper('S1')]).ok).toBe(false);
    expect(evaluateLabelRules(r, [src({ handle: 'S1', sourceType: 'review_article' })]).ok).toBe(true);
    const bad = evaluateLabelRules(r, [src({ handle: 'S1', sourceType: 'patent' }), src({ handle: 'S2', sourceType: 'preprint' })]);
    expect(bad.ok).toBe(false); expect(bad.reason).toContain('needs 2 source(s) of type');
  });
  it('a failed-verification source never counts', () => {
    expect(evaluateLabelRules(rules('established_science'), [paper('S1'), paper('S2', { verification: 'failed' })]).ok).toBe(false);
    expect(evaluateLabelRules(rules('established_science'), [paper('S1'), paper('S2', { verification: 'unverified' })]).ok).toBe(true);
  });
  it('test-data flag: a patent supports Experimental only if the model asserts test data AND a quote from that source verified', () => {
    const r = rules('experimental'); const pat = (o = {}) => src({ handle: 'S1', sourceType: 'patent', ...o });
    expect(evaluateLabelRules(r, [pat()]).ok).toBe(false);
    expect(evaluateLabelRules(r, [pat({ reportsTestData: true })]).ok).toBe(false);                      // claimed but no verified quote
    expect(evaluateLabelRules(r, [pat({ reportsTestData: true, hasVerifiedQuote: true })]).ok).toBe(true);
    expect(evaluateLabelRules(r, [paper('S1')]).ok).toBe(true);                                         // peer-reviewed needs no flag
    expect(evaluateLabelRules(r, [src({ handle: 'S1', sourceType: 'preprint' })]).ok).toBe(true);       // preprints qualify as written
  });
  it('commercial use: a paper or a patent alone does not qualify; a company page or trade press does', () => {
    const r = rules('demonstrated_commercial_use');
    expect(evaluateLabelRules(r, [paper('S1')]).ok).toBe(false);
    expect(evaluateLabelRules(r, [src({ handle: 'S1', sourceType: 'patent' })]).ok).toBe(false);
    expect(evaluateLabelRules(r, [src({ handle: 'S1', sourceType: 'trade_press' })]).ok).toBe(true);
  });
  it('our hypothesis may have zero sources; other labels need sources', () => {
    expect(evaluateLabelRules(rules('our_hypothesis'), []).ok).toBe(true);
    expect(evaluateLabelRules(rules('theoretical'), []).ok).toBe(false);
    expect(evaluateLabelRules(rules('theoretical'), [src({ handle: 'S1', sourceType: 'trade_press' })]).ok).toBe(true);
  });
  it('strongestSupported gives the ceiling on the strength chain: patent alone Theoretical, patent with verified test data Experimental, one paper Experimental, two papers Established', () => {
    expect(strongestSupported(labels(), [src({ handle: 'S1', sourceType: 'patent' })])!.key).toBe('theoretical');
    expect(strongestSupported(labels(), [src({ handle: 'S1', sourceType: 'patent', reportsTestData: true, hasVerifiedQuote: true })])!.key).toBe('experimental');
    expect(strongestSupported(labels(), [paper('S1')])!.key).toBe('experimental');
    expect(strongestSupported(labels(), [paper('S1'), paper('S2')])!.key).toBe('established_science');
    expect(strongestSupported(labels(), [])).toBeNull();
  });
});

describe("the Architect's v2 evidence_labels.md (the seeded file)", () => {
  const real = () => parsePromptFile(readFileSync(join(__dirname, '../../prompts/seed/evidence_labels.md'), 'utf8')).parsed!.labels!;
  const s = (sourceType: string, o: Partial<CitedSource> = {}, handle = 'S1') => src({ handle, sourceType, ...o });
  it('validates with no errors or warnings and encodes the confirmed ordering', () => {
    const r = parsePromptFile(readFileSync(join(__dirname, '../../prompts/seed/evidence_labels.md'), 'utf8'));
    expect(r.errors).toEqual([]); expect(r.warnings).toEqual([]);
    const st = Object.fromEntries(real().map(l => [l.key, l.strength]));
    expect(st).toEqual({ established_science: 4, demonstrated_commercial_use: undefined, experimental: 2, theoretical: 1, our_hypothesis: 0 });
  });
  it('ceilings: nothing -> Our hypothesis; patent alone -> Theoretical; patent with verified test data -> Experimental; one paper -> Experimental; two papers -> Established; a review alone -> Established', () => {
    const top = (srcs: CitedSource[]) => strongestSupported(real(), srcs)!.key;
    expect(top([])).toBe('our_hypothesis');
    expect(top([s('patent')])).toBe('theoretical');
    expect(top([s('patent', { reportsTestData: true, hasVerifiedQuote: true })])).toBe('experimental');
    expect(top([s('peer_reviewed_paper')])).toBe('experimental');
    expect(top([s('peer_reviewed_paper'), s('peer_reviewed_paper', {}, 'S2')])).toBe('established_science');
    expect(top([s('review_article')])).toBe('established_science');
  });
  it('a single preprint or company page never reaches Established science; trade press alone is only Theoretical', () => {
    const top = (srcs: CitedSource[]) => strongestSupported(real(), srcs)!.key;
    expect(top([s('preprint')])).toBe('experimental');
    expect(top([s('preprint'), s('company_web', {}, 'S2')])).toBe('experimental');
    expect(top([s('trade_press')])).toBe('theoretical');
  });
  it('Demonstrated commercial use is checked on its own axis (any listed source type qualifies as written)', () => {
    const dcu = real().find(l => l.key === 'demonstrated_commercial_use')!;
    expect(evaluateLabelRules(dcu.rules, [s('company_web')]).ok).toBe(true);
    expect(evaluateLabelRules(dcu.rules, [s('patent')]).ok).toBe(false);
  });
});
