import { SOURCE_TYPES } from '../pipeline/schemas';
import type { Issue } from './parse';

export interface LabelRuleOption { min_sources: number; source_types?: string[]; requires_test_data?: boolean; requires_named_use?: boolean }
export interface LabelRules { any_of?: LabelRuleOption[]; allow_no_sources?: boolean }

const OPTION_KEYS = new Set(['min_sources', 'source_types', 'requires_test_data', 'requires_named_use']);
const RULE_KEYS = new Set(['any_of', 'allow_no_sources']);

/** Validates the optional `rules:` block of one label. Returns the parsed rules (or undefined) and pushes issues. */
export function parseLabelRules(raw: unknown, at: string, errors: Issue[], warnings: Issue[]): LabelRules | undefined {
  if (raw === undefined) return undefined;
  const bad = (m: string) => errors.push({ code: 'bad_rules', message: `${at}: ${m}` });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { bad('rules must be a mapping'); return undefined; }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) warnings.push({ code: 'unknown_field', message: `${at}: unknown rules field "${k}" is ignored` });
  const out: LabelRules = {};
  if (r.allow_no_sources !== undefined) { if (typeof r.allow_no_sources !== 'boolean') bad('allow_no_sources must be true or false'); else out.allow_no_sources = r.allow_no_sources; }
  if (r.any_of !== undefined) {
    if (!Array.isArray(r.any_of) || r.any_of.length === 0) bad('any_of must be a non-empty list of options');
    else {
      out.any_of = [];
      r.any_of.forEach((o: any, i: number) => {
        const oat = `any_of option ${i + 1}`;
        for (const k of Object.keys(o ?? {})) if (!OPTION_KEYS.has(k)) warnings.push({ code: 'unknown_field', message: `${at}: ${oat}: unknown field "${k}" is ignored` });
        if (!Number.isInteger(o?.min_sources) || o.min_sources < 1) { bad(`${oat}: min_sources must be an integer of at least 1`); return; }
        if (o.source_types !== undefined && !(Array.isArray(o.source_types) && o.source_types.length && o.source_types.every((t: unknown) => (SOURCE_TYPES as readonly string[]).includes(t as string))))
          { bad(`${oat}: source_types must be a non-empty list drawn from ${SOURCE_TYPES.join(', ')}`); return; }
        if (o.requires_test_data !== undefined && typeof o.requires_test_data !== 'boolean') { bad(`${oat}: requires_test_data must be true or false`); return; }
        if (o.requires_named_use !== undefined && typeof o.requires_named_use !== 'boolean') { bad(`${oat}: requires_named_use must be true or false`); return; }
        out.any_of!.push({ min_sources: o.min_sources, source_types: o.source_types, requires_test_data: o.requires_test_data, requires_named_use: o.requires_named_use });
      });
    }
  }
  return out;
}

export interface CitedSource {
  handle: string; sourceType: string;
  verification: 'verified' | 'unverified' | 'failed';
  /** model-asserted */ reportsTestData: boolean | null;
  /** model-asserted: the source names a real product, process or user */ namesRealUse: boolean | null;
  hasVerifiedQuote: boolean;
}

/** A test-data claim only counts if a quote from that same source was verified against retrieved text. */
export const effectiveTestData = (s: CitedSource) => s.reportsTestData === true && s.hasVerifiedQuote;
/** Same condition for the named-use flag: asserted by the model AND backed by a verified quote from that source. */
export const effectiveNamedUse = (s: CitedSource) => s.namesRealUse === true && s.hasVerifiedQuote;

export interface LabelCheck { ok: boolean; reason?: string }

export function evaluateLabelRules(rules: LabelRules | undefined, sources: CitedSource[]): LabelCheck {
  if (!rules || (!rules.any_of && rules.allow_no_sources === undefined)) return { ok: true };
  if (sources.length === 0) return rules.allow_no_sources ? { ok: true } : { ok: false, reason: 'this label needs at least one cited source' };
  if (!rules.any_of) return { ok: true };
  const live = sources.filter(s => s.verification !== 'failed');       // failed sources never count; unverified-but-retrieved ones do
  const unmet: string[] = [];
  for (const o of rules.any_of) {
    const eligible = live.filter(s => (!o.source_types || o.source_types.includes(s.sourceType)) && (!o.requires_test_data || effectiveTestData(s)) && (!o.requires_named_use || effectiveNamedUse(s)));
    if (eligible.length >= o.min_sources) return { ok: true };
    unmet.push(`${o.min_sources} source(s)${o.source_types ? ` of type ${o.source_types.join('/')}` : ''}${o.requires_test_data ? ' reporting verified test data' : ''}${o.requires_named_use ? ' naming a real use (verified quote)' : ''} (found ${eligible.length})`);
  }
  return { ok: false, reason: `cited sources do not meet any option: needs ${unmet.join(' OR ')}` };
}

/** Highest-strength label whose rules the sources satisfy. Labels without a strength are ignored. */
export function strongestSupported<T extends { key: string; strength?: number; rules?: LabelRules }>(labels: T[], sources: CitedSource[]): T | null {
  const ranked = labels.filter(l => l.strength !== undefined).sort((a, b) => b.strength! - a.strength!);
  return ranked.find(l => evaluateLabelRules(l.rules, sources).ok) ?? null;
}
