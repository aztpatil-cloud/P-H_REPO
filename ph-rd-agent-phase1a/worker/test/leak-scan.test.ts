import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Model independence is enforced mechanically: vendor names, SDK imports and model-id strings may
// appear ONLY inside src/providers/<adapter>/ , the composition root, and one allow-listed lint file.
const SRC = join(__dirname, '../src');
const ALLOWED = [/^providers\/gemini\//, /^providers\/index\.ts$/, /^prompts\/neutrality\.ts$/];
const FORBIDDEN = /(gemini|generativelanguage|googleapis|@google\/|openai|anthropic|claude|gpt-?\d|llama|mistral)/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(f => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

describe('leak scan', () => {
  it('no vendor or model names outside the adapter folders', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replaceAll('\\', '/');
      if (ALLOWED.some(a => a.test(rel))) continue;
      const hit = FORBIDDEN.exec(readFileSync(file, 'utf8'));
      if (hit) offenders.push(`${rel}: "${hit[0]}"`);
    }
    expect(offenders).toEqual([]);
  });
});
