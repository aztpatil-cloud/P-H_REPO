import { parse as parseYaml } from 'yaml';
import type { ModelCapabilities } from '../providers/types';
import { NEUTRALITY_RULES } from './neutrality';
import { parseLabelRules, type LabelRules } from './label-rules';

export type PromptKind = 'stage1_plan' | 'stage2_research' | 'report_template' | 'evidence_labels';
export const PROMPT_KINDS: PromptKind[] = ['stage1_plan', 'stage2_research', 'report_template', 'evidence_labels'];
export const SUPPORTED_SCHEMA_VERSION = 1;

export interface Requires {
  structured_output?: boolean; tool_calling?: boolean; min_context_tokens?: number; min_output_tokens?: number;
}
export interface LabelDef { key: string; name: string; definition: string; criteria?: string; examples?: string[]; strength?: number; rules?: LabelRules }
export interface SectionDef { key: string; title: string; instruction: string; required: boolean; order: number; max_words?: number }
export interface Issue { code: string; message: string; line?: number }

export interface ParsedPrompt {
  kind: PromptKind; name: string; schemaVersion: number; notes?: string; requires: Requires;
  body: string; variables: string[]; labels?: LabelDef[]; sections?: SectionDef[];
}
export interface ParseResult { ok: boolean; errors: Issue[]; warnings: Issue[]; parsed?: ParsedPrompt }

/** Variables the platform fills in per kind. Anything else is rejected. */
export const ALLOWED_VARIABLES: Record<'stage1_plan' | 'stage2_research', string[]> = {
  stage1_plan: ['problem', 'industries_include', 'industries_exclude', 'available_sources', 'label_definitions', 'today'],
  stage2_research: ['problem', 'approved_plan', 'label_definitions', 'available_sources', 'budget_note', 'today'],
};
export const REQUIRED_VARIABLES: Record<'stage1_plan' | 'stage2_research', string[]> = {
  stage1_plan: ['problem'],
  stage2_research: ['problem', 'approved_plan', 'label_definitions'],
};

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const FRONT_KEYS = new Set(['kind', 'name', 'schema_version', 'notes', 'requires']);
const PLATFORM_KEYS = new Set(['version', 'status', 'author', 'id', 'activated_at']);
const REQ_KEYS = new Set(['structured_output', 'tool_calling', 'min_context_tokens', 'min_output_tokens']);

const lineOf = (text: string, idx: number) => text.slice(0, idx).split('\n').length;

export function splitFrontmatter(content: string): { front?: string; body: string; bodyStartLine: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { body: content, bodyStartLine: 1 };
  return { front: m[1], body: m[2] ?? '', bodyStartLine: (m[1] ?? '').split('\n').length + 3 };
}

export function parsePromptFile(content: string, expectedKind?: PromptKind): ParseResult {
  const errors: Issue[] = []; const warnings: Issue[] = [];
  const fail = () => ({ ok: false, errors, warnings } as ParseResult);

  const { front, body, bodyStartLine } = splitFrontmatter(content);
  if (front === undefined) { errors.push({ code: 'no_frontmatter', message: 'file must start with a --- YAML frontmatter block' }); return fail(); }
  let fm: Record<string, unknown>;
  try { const y = parseYaml(front); if (typeof y !== 'object' || y === null || Array.isArray(y)) throw new Error('not a mapping'); fm = y as Record<string, unknown>; }
  catch (e) { errors.push({ code: 'bad_frontmatter', message: `frontmatter is not valid YAML: ${(e as Error).message}` }); return fail(); }

  for (const k of Object.keys(fm)) {
    if (PLATFORM_KEYS.has(k)) errors.push({ code: 'platform_field', message: `"${k}" is assigned by the platform; remove it from the file` });
    else if (!FRONT_KEYS.has(k)) warnings.push({ code: 'unknown_field', message: `unknown frontmatter field "${k}" is ignored` });
  }
  const kind = fm.kind as PromptKind;
  if (!PROMPT_KINDS.includes(kind)) { errors.push({ code: 'bad_kind', message: `kind must be one of ${PROMPT_KINDS.join(', ')}` }); return fail(); }
  if (expectedKind && kind !== expectedKind) errors.push({ code: 'kind_mismatch', message: `file declares kind "${kind}" but was saved as "${expectedKind}"` });
  if (typeof fm.name !== 'string' || !fm.name.trim()) errors.push({ code: 'no_name', message: 'name is required' });
  const schemaVersion = fm.schema_version === undefined ? 1 : fm.schema_version;
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) errors.push({ code: 'schema_version', message: `schema_version must be ${SUPPORTED_SCHEMA_VERSION}` });

  const requires = parseRequires(fm.requires, errors);

  if (NEUTRALITY_RULES.length) for (const rule of NEUTRALITY_RULES) {
    const g = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    for (const m of body.matchAll(g)) {
      const issue = { code: rule.code, message: `"${m[0]}" ${rule.message}`, line: bodyStartLine - 1 + lineOf(body, m.index ?? 0) };
      (rule.severity === 'error' ? errors : warnings).push(issue);
    }
  }
  if (/placeholder/i.test(body)) warnings.push({ code: 'placeholder', message: 'file still contains PLACEHOLDER text; the Architect should replace it before activation' });

  const parsed: ParsedPrompt = {
    kind, name: typeof fm.name === 'string' ? fm.name : '', schemaVersion: SUPPORTED_SCHEMA_VERSION,
    notes: typeof fm.notes === 'string' ? fm.notes : undefined, requires, body, variables: [],
  };

  if (kind === 'stage1_plan' || kind === 'stage2_research') {
    if (!body.trim()) errors.push({ code: 'empty_body', message: 'instructions are empty' });
    const found = new Set<string>();
    for (const m of body.matchAll(VAR_RE)) {
      const name = m[1]!; found.add(name);
      if (!ALLOWED_VARIABLES[kind].includes(name))
        errors.push({ code: 'unknown_variable', message: `unknown variable {{${name}}}; allowed: ${ALLOWED_VARIABLES[kind].join(', ')}`, line: bodyStartLine - 1 + lineOf(body, m.index ?? 0) });
    }
    const stripped = body.replace(VAR_RE, '');
    if (stripped.includes('{{') || stripped.includes('}}')) errors.push({ code: 'malformed_variable', message: 'unbalanced {{ }} in instructions' });
    for (const req of REQUIRED_VARIABLES[kind]) if (!found.has(req)) errors.push({ code: 'missing_variable', message: `required variable {{${req}}} is not used` });
    parsed.variables = [...found];
  } else {
    let y: unknown;
    try { y = parseYaml(body); } catch (e) { errors.push({ code: 'bad_body', message: `body is not valid YAML: ${(e as Error).message}` }); return { ok: false, errors, warnings }; }
    if (kind === 'report_template') parsed.sections = parseSections(y, errors);
    else parsed.labels = parseLabels(y, errors, warnings);
  }
  return { ok: errors.length === 0, errors, warnings, parsed: errors.length === 0 ? parsed : undefined };
}

function parseRequires(v: unknown, errors: Issue[]): Requires {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) { errors.push({ code: 'bad_requires', message: 'requires must be a mapping' }); return {}; }
  const out: Requires = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!REQ_KEYS.has(k)) { errors.push({ code: 'bad_requires', message: `unknown requirement "${k}"` }); continue; }
    if (k.startsWith('min_')) {
      if (!Number.isInteger(val) || (val as number) <= 0) errors.push({ code: 'bad_requires', message: `${k} must be a positive integer` });
      else (out as any)[k] = val;
    } else if (typeof val !== 'boolean') errors.push({ code: 'bad_requires', message: `${k} must be true or false` });
    else (out as any)[k] = val;
  }
  return out;
}

function parseSections(y: unknown, errors: Issue[]): SectionDef[] | undefined {
  const list = (y as any)?.sections;
  if (!Array.isArray(list) || list.length === 0) { errors.push({ code: 'no_sections', message: 'body must be YAML with a non-empty "sections:" list' }); return undefined; }
  const seen = new Set<string>(); const out: SectionDef[] = [];
  list.forEach((s: any, i: number) => {
    const at = `section ${i + 1}`;
    if (typeof s?.key !== 'string' || !KEY_RE.test(s.key)) { errors.push({ code: 'bad_section', message: `${at}: key must be lowercase letters, digits, underscores` }); return; }
    if (seen.has(s.key)) errors.push({ code: 'duplicate_key', message: `${at}: duplicate key "${s.key}"` });
    seen.add(s.key);
    if (typeof s.title !== 'string' || !s.title.trim()) errors.push({ code: 'bad_section', message: `${at} (${s.key}): title required` });
    if (typeof s.instruction !== 'string' || !s.instruction.trim()) errors.push({ code: 'bad_section', message: `${at} (${s.key}): instruction required` });
    if (s.max_words !== undefined && (!Number.isInteger(s.max_words) || s.max_words <= 0)) errors.push({ code: 'bad_section', message: `${at} (${s.key}): max_words must be a positive integer` });
    if (s.order !== undefined && !Number.isInteger(s.order)) errors.push({ code: 'bad_section', message: `${at} (${s.key}): order must be an integer` });
    out.push({ key: s.key, title: s.title, instruction: s.instruction, required: s.required !== false, order: s.order ?? i + 1, max_words: s.max_words });
  });
  return out.sort((a, b) => a.order - b.order);
}

const LABEL_KEYS = new Set(['key', 'name', 'definition', 'criteria', 'examples', 'strength', 'rules']);
function parseLabels(y: unknown, errors: Issue[], warnings: Issue[]): LabelDef[] | undefined {
  const list = (y as any)?.labels;
  if (!Array.isArray(list) || list.length === 0) { errors.push({ code: 'no_labels', message: 'body must be YAML with a non-empty "labels:" list' }); return undefined; }
  const seen = new Set<string>(); const out: LabelDef[] = [];
  list.forEach((l: any, i: number) => {
    const at = `label ${i + 1}`;
    if (typeof l?.key !== 'string' || !KEY_RE.test(l.key)) { errors.push({ code: 'bad_label', message: `${at}: key must be lowercase letters, digits, underscores` }); return; }
    if (seen.has(l.key)) errors.push({ code: 'duplicate_key', message: `${at}: duplicate key "${l.key}"` });
    seen.add(l.key);
    if (typeof l.name !== 'string' || !l.name.trim()) errors.push({ code: 'bad_label', message: `${at} (${l.key}): name required` });
    if (typeof l.definition !== 'string' || !l.definition.trim()) errors.push({ code: 'bad_label', message: `${at} (${l.key}): definition required` });
    if (l.examples !== undefined && !(Array.isArray(l.examples) && l.examples.every((e: unknown) => typeof e === 'string')))
      errors.push({ code: 'bad_label', message: `${at} (${l.key}): examples must be a list of strings` });
    for (const k of Object.keys(l)) if (!LABEL_KEYS.has(k)) warnings.push({ code: 'unknown_field', message: `${at} (${l.key}): unknown field "${k}" is ignored` });
    if (l.strength !== undefined && !(Number.isInteger(l.strength) && l.strength >= 0)) errors.push({ code: 'bad_label', message: `${at} (${l.key}): strength must be an integer of 0 or more (higher = stronger label)` });
    const rules = parseLabelRules(l.rules, `${at} (${l.key}) rules`, errors, warnings);
    out.push({ key: l.key, name: l.name, definition: l.definition, criteria: l.criteria, examples: l.examples, strength: l.strength, rules });
  });
  return out;
}

/** Cross-file checks run at activation time against the other files that will be live with it. */
export function checkLabelContinuity(newLabels: LabelDef[], usedKeys: string[]): Issue[] {
  const keys = new Set(newLabels.map(l => l.key));
  return usedKeys.filter(k => !keys.has(k)).map(k => ({ code: 'label_removed', message: `label "${k}" is used by saved findings and cannot be removed; mark it deprecated instead` }));
}

export const PLATFORM_MINIMUMS: Record<PromptKind, Requires> = {
  stage1_plan: { structured_output: true, min_output_tokens: 4_000 },
  stage2_research: { structured_output: true, tool_calling: true, min_context_tokens: 100_000, min_output_tokens: 8_000 },
  report_template: { structured_output: false },
  evidence_labels: {},
};

/** The stricter of the platform minimum and what the file asks for. */
export function mergeRequires(a: Requires, b: Requires): Requires {
  const m: Requires = {};
  if (a.structured_output || b.structured_output) m.structured_output = true;
  if (a.tool_calling || b.tool_calling) m.tool_calling = true;
  const ctx = Math.max(a.min_context_tokens ?? 0, b.min_context_tokens ?? 0); if (ctx) m.min_context_tokens = ctx;
  const out = Math.max(a.min_output_tokens ?? 0, b.min_output_tokens ?? 0); if (out) m.min_output_tokens = out;
  return m;
}

/** Returns human-readable reasons a model cannot serve these requirements (empty = eligible). */
export function unmetRequirements(req: Requires, caps: ModelCapabilities): string[] {
  const why: string[] = [];
  if (req.structured_output && !caps.structuredOutput) why.push('needs structured output');
  if (req.tool_calling && !caps.toolCalling) why.push('needs tool calling');
  if (req.min_context_tokens && caps.contextTokens < req.min_context_tokens) why.push(`needs context of at least ${req.min_context_tokens} tokens (model has ${caps.contextTokens})`);
  if (req.min_output_tokens && caps.maxOutputTokens < req.min_output_tokens) why.push(`needs output of at least ${req.min_output_tokens} tokens (model has ${caps.maxOutputTokens})`);
  return why;
}

/** Fills {{variables}}; throws on a missing value so a run never sends a half-filled prompt. */
export function renderPrompt(body: string, vars: Record<string, string>): string {
  return body.replace(VAR_RE, (_, name: string) => {
    if (!(name in vars)) throw new Error(`no value supplied for {{${name}}}`);
    return vars[name]!;
  });
}
