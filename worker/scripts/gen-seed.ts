import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSeedSql } from '../src/seed/build-seed';
import { PROMPT_KINDS, type PromptKind } from '../src/prompts/parse';

const root = join(__dirname, '../..');
const files = Object.fromEntries(PROMPT_KINDS.map(k => [k, readFileSync(join(root, 'prompts/seed', `${k}.md`), 'utf8')])) as Record<PromptKind, string>;
writeFileSync(join(root, 'supabase/seed.sql'), buildSeedSql(files));
console.log('wrote supabase/seed.sql');
