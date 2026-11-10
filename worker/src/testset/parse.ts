import { parse as parseYaml } from 'yaml';
import { validateAgainstSchema } from '../providers/schema';
import { stage1PlanSchema } from '../pipeline/schemas';

export interface Issue { code: string; message: string }
export interface RubricDim { key: string; name: string; description: string; scale: { min: number; max: number }; weight: number; anchors: Record<number, string>; applies_to?: string[] }
export interface TestCase { key: string; title: string; problem: string; industries_include: string[]; industries_exclude: string[]; confidential: boolean; expected_notes?: string; reference_plan?: unknown }
export interface TestSetFile { schemaVersion: 1; name: string; description?: string; rubric: RubricDim[]; cases: TestCase[] }
export interface TestSetResult { ok: boolean; errors: Issue[]; warnings: Issue[]; parsed?: TestSetFile }

const KEY = /^[a-z][a-z0-9_]*$/;
const TOP = new Set(['schema_version', 'name', 'description', 'rubric', 'cases']);
const DIM = new Set(['key', 'name', 'description', 'scale', 'weight', 'anchors', 'applies_to']);
const CASE = new Set(['key', 'title', 'problem', 'industries_include', 'industries_exclude', 'confidential', 'expected_notes', 'reference_plan']);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function parseTestSet(content: string): TestSetResult {
  const errors: Issue[] = []; const warnings: Issue[] = [];
  const err = (code: string, message: string) => errors.push({ code, message });
  let y: any;
  try { y = parseYaml(content); } catch (e) { err('bad_yaml', (e as Error).message); return { ok: false, errors, warnings }; }
  if (!y || typeof y !== 'object' || Array.isArray(y)) { err('bad_shape', 'file must be a YAML mapping'); return { ok: false, errors, warnings }; }
  for (const k of Object.keys(y)) if (!TOP.has(k)) warnings.push({ code: 'unknown_field', message: `unknown top-level field "${k}" is ignored` });
  if (y.schema_version !== 1) err('schema_version', 'schema_version must be 1');
  if (!nonEmpty(y.name)) err('no_name', 'name is required');

  const rubric: RubricDim[] = [];
  if (!Array.isArray(y.rubric) || y.rubric.length === 0) err('no_rubric', 'rubric must be a non-empty list');
  const dimKeys = new Set<string>();
  (Array.isArray(y.rubric) ? y.rubric : []).forEach((d: any, i: number) => {
    const at = `rubric[${i + 1}]${d?.key ? ` (${d.key})` : ''}`;
    for (const k of Object.keys(d ?? {})) if (!DIM.has(k)) warnings.push({ code: 'unknown_field', message: `${at}: unknown field "${k}" is ignored` });
    if (typeof d?.key !== 'string' || !KEY.test(d.key)) { err('bad_key', `${at}: key must be lowercase letters, digits, underscores`); return; }
    if (dimKeys.has(d.key)) err('duplicate_key', `${at}: duplicate dimension key`); dimKeys.add(d.key);
    if (!nonEmpty(d.name)) err('bad_dimension', `${at}: name required`);
    if (!nonEmpty(d.description)) err('bad_dimension', `${at}: description required`);
    const { min, max } = d.scale ?? {};
    if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) { err('bad_scale', `${at}: scale needs integer min below integer max`); return; }
    const weight = d.weight === undefined ? 1 : d.weight;
    if (typeof weight !== 'number' || !(weight > 0)) err('bad_weight', `${at}: weight must be a number above 0`);
    const anchors: Record<number, string> = {};
    if (d.anchors !== undefined) {
      if (typeof d.anchors !== 'object' || d.anchors === null || Array.isArray(d.anchors)) err('bad_anchors', `${at}: anchors must be a mapping of score to text`);
      else for (const [s, t] of Object.entries(d.anchors)) {
        const n = Number(s);
        if (!Number.isInteger(n) || n < min || n > max) err('bad_anchors', `${at}: anchor ${s} is outside the scale ${min}..${max}`);
        else if (!nonEmpty(t)) err('bad_anchors', `${at}: anchor ${s} needs text`); else anchors[n] = t;
      }
    }
    if (d.applies_to !== undefined && !(Array.isArray(d.applies_to) && d.applies_to.length && d.applies_to.every((c: unknown) => typeof c === 'string')))
      err('bad_applies_to', `${at}: applies_to must be a non-empty list of case keys`);
    rubric.push({ key: d.key, name: d.name, description: d.description, scale: { min, max }, weight: weight as number, anchors, applies_to: d.applies_to });
  });

  const cases: TestCase[] = [];
  if (!Array.isArray(y.cases) || y.cases.length === 0) err('no_cases', 'cases must be a non-empty list');
  const caseKeys = new Set<string>();
  (Array.isArray(y.cases) ? y.cases : []).forEach((c: any, i: number) => {
    const at = `cases[${i + 1}]${c?.key ? ` (${c.key})` : ''}`;
    for (const k of Object.keys(c ?? {})) if (!CASE.has(k)) warnings.push({ code: 'unknown_field', message: `${at}: unknown field "${k}" is ignored` });
    if (typeof c?.key !== 'string' || !KEY.test(c.key)) { err('bad_key', `${at}: key must be lowercase letters, digits, underscores`); return; }
    if (caseKeys.has(c.key)) err('duplicate_key', `${at}: duplicate case key`); caseKeys.add(c.key);
    if (!nonEmpty(c.title)) err('bad_case', `${at}: title required`);
    if (!nonEmpty(c.problem)) err('bad_case', `${at}: problem required`);
    for (const f of ['industries_include', 'industries_exclude'] as const)
      if (c[f] !== undefined && !(Array.isArray(c[f]) && c[f].every((s: unknown) => typeof s === 'string'))) err('bad_case', `${at}: ${f} must be a list of strings`);
    if (c.confidential !== undefined && typeof c.confidential !== 'boolean') err('bad_case', `${at}: confidential must be true or false`);
    if (c.expected_notes !== undefined && typeof c.expected_notes !== 'string') err('bad_case', `${at}: expected_notes must be text`);
    if (c.reference_plan !== undefined) {
      const problems = validateAgainstSchema(c.reference_plan, stage1PlanSchema());
      if (problems.length) err('bad_reference_plan', `${at}: reference_plan does not match the stage 1 plan shape: ${problems.slice(0, 3).join('; ')}`);
    }
    cases.push({ key: c.key, title: c.title, problem: String(c.problem).trim(), industries_include: c.industries_include ?? [], industries_exclude: c.industries_exclude ?? [],
      confidential: c.confidential ?? true, expected_notes: c.expected_notes, reference_plan: c.reference_plan });
  });
  for (const d of rubric) for (const ck of d.applies_to ?? []) if (!caseKeys.has(ck)) err('bad_applies_to', `rubric (${d.key}): applies_to refers to unknown case "${ck}"`);

  const parsed: TestSetFile | undefined = errors.length ? undefined : { schemaVersion: 1, name: y.name, description: y.description, rubric, cases };
  return { ok: errors.length === 0, errors, warnings, parsed };
}

/** Is this dimension scored for this case? Without applies_to every dimension is open, but "not applicable" is always allowed. */
export const dimensionApplies = (d: RubricDim, caseKey: string) => !d.applies_to || d.applies_to.includes(caseKey);

/** Weighted total as a percentage. null (not applicable) scores are left out of BOTH numerator and denominator,
 *  so a case is never penalised for a dimension that doesn't apply to it. Returns null if nothing was scored. */
export function weightedScore(scores: Record<string, number | null | undefined>, rubric: RubricDim[], caseKey: string): number | null {
  let got = 0; let possible = 0;
  for (const d of rubric) {
    const s = scores[d.key];
    if (s === null || s === undefined || !dimensionApplies(d, caseKey)) continue;
    if (!Number.isInteger(s) || s < d.scale.min || s > d.scale.max) throw new Error(`score ${s} for "${d.key}" is outside ${d.scale.min}..${d.scale.max}`);
    got += (s - d.scale.min) * d.weight; possible += (d.scale.max - d.scale.min) * d.weight;
  }
  return possible === 0 ? null : (got / possible) * 100;
}
