import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLabelContinuity, mergeRequires, parsePromptFile, PLATFORM_MINIMUMS, renderPrompt, unmetRequirements } from '../src/prompts/parse';
import { MODEL, NO_TOOLS } from './fixtures';

const def = (f: string) => readFileSync(join(__dirname, 'fixtures/placeholder-prompts', f), 'utf8');
const stage1 = (body: string, extra = '') => `---\nkind: stage1_plan\nname: t\n${extra}---\n${body}`;
const codes = (r: ReturnType<typeof parsePromptFile>) => r.errors.map(e => e.code);

describe('shipped default files', () => {
  it('all four validate and carry placeholder warnings', () => {
    for (const [f, k] of [['stage1_plan.md', 'stage1_plan'], ['stage2_research.md', 'stage2_research'], ['report_template.md', 'report_template'], ['evidence_labels.md', 'evidence_labels']] as const) {
      const r = parsePromptFile(def(f), k);
      expect(r.errors, f).toEqual([]); expect(r.ok).toBe(true);
      expect(r.warnings.map(w => w.code)).toContain('placeholder');
    }
  });
  it('template has the nine sections in order; labels has five keys', () => {
    expect(parsePromptFile(def('report_template.md')).parsed!.sections!.map(s => s.key)).toEqual(
      ['problem', 'mechanism', 'technology_discovery', 'evidence', 'technical_evaluation', 'ph_application', 'commercial_feasibility', 'experiment_proposal', 'recommendation']);
    expect(parsePromptFile(def('evidence_labels.md')).parsed!.labels!.map(l => l.key)).toEqual(
      ['established_science', 'demonstrated_commercial_use', 'experimental', 'theoretical', 'our_hypothesis']);
  });
});

describe('stage prompts', () => {
  it('requires the required variables and rejects unknown ones (with line numbers)', () => {
    expect(codes(parsePromptFile(stage1('no variables here')))).toContain('missing_variable');
    const r = parsePromptFile(stage1('line one\nUse {{problem}} and {{secret_thing}}'));
    expect(r.errors.find(e => e.code === 'unknown_variable')).toMatchObject({ line: 6 });
  });
  it('stage 2 must use problem, approved_plan and label_definitions', () => {
    const r = parsePromptFile(`---\nkind: stage2_research\nname: t\n---\nOnly {{problem}}`);
    expect(r.errors.filter(e => e.code === 'missing_variable')).toHaveLength(2);
  });
  it('rejects unbalanced braces', () => { expect(codes(parsePromptFile(stage1('{{problem}} and {{oops')))).toContain('malformed_variable'); });
  it('rejects fields the platform assigns', () => {
    expect(codes(parsePromptFile(stage1('{{problem}}', 'status: active\nversion: 9\n')))).toEqual(['platform_field', 'platform_field']);
  });
  it('kind mismatch and bad frontmatter are reported, not thrown', () => {
    expect(codes(parsePromptFile(stage1('{{problem}}'), 'stage2_research'))).toContain('kind_mismatch');
    expect(codes(parsePromptFile('just text'))).toEqual(['no_frontmatter']);
    expect(codes(parsePromptFile('---\nkind: [oops\n---\nx'))).toEqual(['bad_frontmatter']);
    expect(codes(parsePromptFile('---\nkind: nonsense\nname: x\n---\nx'))).toEqual(['bad_kind']);
  });
});

describe('provider neutrality lint', () => {
  it('rejects vendor/model names, chat-template tokens and tool syntax', () => {
    expect(codes(parsePromptFile(stage1('Ask the model. {{problem}} You are Gemini.')))).toContain('vendor_name');
    expect(codes(parsePromptFile(stage1('[INST] {{problem}} [/INST]')))).toContain('chat_template_token');
    expect(codes(parsePromptFile(stage1('{{problem}} emit functionCall objects')))).toContain('tool_syntax');
    expect(codes(parsePromptFile(stage1('{{problem}} Use GPT-5 style reasoning')))).toContain('vendor_name');
  });
  it('ordinary food vocabulary is not mistaken for a model name (e.g. palm oil)', () => {
    expect(parsePromptFile(stage1('Find alternatives to palm oil for {{problem}}')).ok).toBe(true);
  });
  it('JSON-mode talk is only a warning', () => {
    const r = parsePromptFile(stage1('{{problem}} Respond only in JSON.'));
    expect(r.ok).toBe(true); expect(r.warnings.map(w => w.code)).toContain('json_mode_instruction');
  });
  it('clean neutral text passes', () => { expect(parsePromptFile(stage1('Investigate: {{problem}}')).ok).toBe(true); });
});

describe('template and labels', () => {
  const tmpl = (y: string) => `---\nkind: report_template\nname: t\n---\n${y}`;
  const lab = (y: string) => `---\nkind: evidence_labels\nname: t\n---\n${y}`;
  it('template: duplicate keys, bad keys, missing instruction, bad max_words', () => {
    const r = parsePromptFile(tmpl('sections:\n  - {key: a, title: A, instruction: x}\n  - {key: a, title: B, instruction: y}\n  - {key: Bad Key, title: C, instruction: z}\n  - {key: d, title: D}\n  - {key: e, title: E, instruction: i, max_words: -3}'));
    expect(codes(r)).toEqual(expect.arrayContaining(['duplicate_key', 'bad_section']));
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });
  it('template: honours explicit order and defaults required=true', () => {
    const s = parsePromptFile(tmpl('sections:\n  - {key: b, title: B, instruction: x, order: 2, required: false}\n  - {key: a, title: A, instruction: y, order: 1}')).parsed!.sections!;
    expect(s.map(x => x.key)).toEqual(['a', 'b']); expect(s[0]!.required).toBe(true); expect(s[1]!.required).toBe(false);
  });
  it('labels: needs key, name, definition; unique keys', () => {
    expect(codes(parsePromptFile(lab('labels: []')))).toEqual(['no_labels']);
    expect(codes(parsePromptFile(lab('labels:\n  - {key: a, name: A}\n  - {key: a, name: A2, definition: d}')))).toEqual(expect.arrayContaining(['bad_label', 'duplicate_key']));
  });
  it('a new label set cannot drop a key that saved findings use', () => {
    const labels = [{ key: 'a', name: 'A', definition: 'd' }];
    expect(checkLabelContinuity(labels, ['a', 'b'])).toEqual([expect.objectContaining({ code: 'label_removed' })]);
    expect(checkLabelContinuity(labels, ['a'])).toEqual([]);
  });
});

describe('requirements', () => {
  it('parses and validates the requires block', () => {
    const ok = parsePromptFile(stage1('{{problem}}', 'requires:\n  tool_calling: true\n  min_context_tokens: 200000\n'));
    expect(ok.parsed!.requires).toEqual({ tool_calling: true, min_context_tokens: 200000 });
    expect(codes(parsePromptFile(stage1('{{problem}}', 'requires:\n  min_context_tokens: -5\n  speed: fast\n')))).toEqual(['bad_requires', 'bad_requires']);
  });
  it('merge takes the stricter; unmet lists reasons', () => {
    const m = mergeRequires(PLATFORM_MINIMUMS.stage2_research, { min_context_tokens: 500_000 });
    expect(m).toMatchObject({ tool_calling: true, structured_output: true, min_context_tokens: 500_000 });
    expect(unmetRequirements(m, MODEL.capabilities)).toEqual([expect.stringContaining('context of at least 500000')]);
    expect(unmetRequirements(m, NO_TOOLS.capabilities).length).toBeGreaterThanOrEqual(3);
    expect(unmetRequirements({}, MODEL.capabilities)).toEqual([]);
  });
});

describe('renderPrompt', () => {
  it('fills variables and refuses to send a half-filled prompt', () => {
    expect(renderPrompt('A {{problem}} B', { problem: 'X' })).toBe('A X B');
    expect(() => renderPrompt('A {{problem}} {{today}}', { problem: 'X' })).toThrow(/today/);
  });
});
