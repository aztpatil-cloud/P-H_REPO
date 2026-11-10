import type { JsonSchema } from './types';

const ALLOWED_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'nullable']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

/** Rejects anything outside our translatable subset (e.g. $ref, oneOf, anyOf). Throws on first problem. */
export function assertSchemaSubset(schema: unknown, path = '$'): asserts schema is JsonSchema {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) throw new Error(`${path}: schema must be an object`);
  const s = schema as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!ALLOWED_KEYS.has(k)) throw new Error(`${path}: unsupported schema keyword "${k}"`);
  if (typeof s.type !== 'string' || !TYPES.has(s.type)) throw new Error(`${path}: missing or unsupported type`);
  if (s.type === 'array') {
    if (!s.items) throw new Error(`${path}: array needs items`);
    assertSchemaSubset(s.items, `${path}[]`);
  }
  if (s.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) assertSchemaSubset(v, `${path}.${k}`);
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in props)) throw new Error(`${path}: required "${r}" not in properties`);
  }
}

/** Validates a value against our subset. Returns a list of human-readable problems (empty = valid). */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  if (value === null) return schema.nullable ? [] : [`${path}: null not allowed`];
  const errs: string[] = [];
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
      const obj = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      for (const r of schema.required ?? []) if (!(r in obj) || obj[r] === undefined) errs.push(`${path}.${r}: required`);
      for (const [k, v] of Object.entries(obj)) {
        const sub = props[k];
        if (!sub) { errs.push(`${path}.${k}: unexpected property`); continue; }
        errs.push(...validateAgainstSchema(v, sub, `${path}.${k}`));
      }
      return errs;
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: expected array`];
      value.forEach((v, i) => errs.push(...validateAgainstSchema(v, schema.items as JsonSchema, `${path}[${i}]`)));
      return errs;
    }
    case 'string': if (typeof value !== 'string') return [`${path}: expected string`]; break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected number`]; break;
    case 'integer': if (typeof value !== 'number' || !Number.isInteger(value)) return [`${path}: expected integer`]; break;
    case 'boolean': if (typeof value !== 'boolean') return [`${path}: expected boolean`]; break;
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) errs.push(`${path}: not one of the allowed values`);
  return errs;
}

/** Extracts a JSON value from model text, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.search(/[{[]/);
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
  throw new Error('no JSON found');
}
