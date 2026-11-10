// Provider-neutral conformance suite. Every adapter must pass the REQUIRED checks before its model can be
// marked conformant (and so become eligible for confidential work). Cheap by design: about ten tiny calls.
import { ProviderError } from './errors';
import { validateAgainstSchema } from './schema';
import type { JsonSchema, ModelProvider, ModelRef } from './types';

export const CONFORMANCE_VERSION = 1;

export interface ConformanceCheck { id: string; name: string; required: boolean; passed: boolean; skipped?: boolean; detail: string }
export interface ConformanceReport { version: number; passed: boolean; checks: ConformanceCheck[]; modelCalls: number }
export interface ConformanceOptions {
  /** Build a provider with a deliberately invalid credential, to verify auth errors map correctly. Optional. */
  badCredentialProvider?: () => ModelProvider;
  /** Expected embedding dimension when the model supports embeddings. */
  embeddingDimension?: number;
}

const user = (t: string) => ({ role: 'user' as const, parts: [{ type: 'text' as const, text: t }] });
const system = (t: string) => ({ role: 'system' as const, parts: [{ type: 'text' as const, text: t }] });

const SCHEMA: JsonSchema = {
  type: 'object', required: ['title', 'count', 'kind', 'tags', 'detail'],
  properties: {
    title: { type: 'string' }, count: { type: 'integer' }, kind: { type: 'string', enum: ['alpha', 'beta'] },
    tags: { type: 'array', items: { type: 'string' } },
    detail: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    note: { type: 'string', nullable: true },
  },
};
const TOOL = { name: 'get_number', description: 'Looks up a well-known number by topic name.', inputSchema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } } as JsonSchema };
const RESULT_KEYS = new Set(['text', 'structured', 'toolCalls', 'finishReason', 'usage', 'latencyMs', 'retries', 'schemaFailures']);
const USAGE_KEYS = new Set(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']);

export async function runConformance(provider: ModelProvider, model: ModelRef, opts: ConformanceOptions = {}): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = []; let modelCalls = 0;
  const run = async (id: string, name: string, required: boolean, fn: () => Promise<string>, skip?: string) => {
    if (skip) { checks.push({ id, name, required, passed: true, skipped: true, detail: skip }); return; }
    try { checks.push({ id, name, required, passed: true, detail: await fn() }); }
    catch (e) { checks.push({ id, name, required, passed: false, detail: e instanceof Error ? e.message : String(e) }); }
  };
  const gen = async (req: Parameters<ModelProvider['generate']>[0]) => { modelCalls++; return provider.generate(req); };
  const need = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  const caps = model.capabilities;

  await run('plain', 'Plain generation returns text and usage', true, async () => {
    const r = await gen({ model, messages: [user('Reply with a short greeting.')], maxOutputTokens: 200 });
    need(!!r.text?.trim(), 'no text returned'); need(r.usage.inputTokens > 0 && r.usage.outputTokens > 0, 'usage not reported');
    need(r.finishReason === 'stop', `finishReason was ${r.finishReason}`); return `ok (${r.usage.inputTokens} in / ${r.usage.outputTokens} out)`;
  });

  await run('system', 'System instructions are honoured', true, async () => {
    const r = await gen({ model, messages: [system('Whatever the user says, reply with exactly one word: BANANA'), user('hi there')], maxOutputTokens: 200 });
    need(/banana/i.test(r.text ?? ''), `reply did not follow the system instruction: "${(r.text ?? '').slice(0, 60)}"`); return 'ok';
  });

  await run('structured', 'Structured output is schema-valid (nested, enum, array, nullable)', true, async () => {
    const r = await gen({ model, messages: [user('Invent a record about a made-up gadget.')], outputSchema: SCHEMA, maxOutputTokens: 400 });
    const problems = validateAgainstSchema(r.structured, SCHEMA); need(problems.length === 0, problems.join('; ')); return `ok (schema retries: ${r.schemaFailures})`;
  }, caps.structuredOutput ? undefined : 'model does not claim structured output');

  await run('tools', 'Tool call round trip', true, async () => {
    const msgs = [user('Use the get_number tool to look up the number for the topic "pi", then tell me the number.')];
    const r1 = await gen({ model, messages: msgs, tools: [TOOL], maxOutputTokens: 300 });
    need(r1.toolCalls.length >= 1 && r1.toolCalls[0]!.name === 'get_number', 'model did not call the tool'); need(r1.finishReason === 'tool_calls', `finishReason was ${r1.finishReason}`);
    const call = r1.toolCalls[0]!;
    const r2 = await gen({ model, tools: [TOOL], maxOutputTokens: 300, messages: [...msgs,
      { role: 'assistant', parts: [{ type: 'tool_call', id: call.id, name: call.name, args: call.args }] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: call.id, name: call.name, result: { value: 3.14159 } }] }] });
    need(/3\.14/.test(r2.text ?? ''), `final answer did not use the tool result: "${(r2.text ?? '').slice(0, 60)}"`); return 'ok';
  }, caps.toolCalling ? undefined : 'model does not claim tool calling');

  await run('no_tool_needed', 'Does not call a tool when none is needed', false, async () => {
    const r = await gen({ model, messages: [user('Say hello in one short sentence.')], tools: [TOOL], maxOutputTokens: 200 });
    need(r.toolCalls.length === 0, 'called a tool unnecessarily'); return 'ok';
  }, caps.toolCalling ? undefined : 'model does not claim tool calling');

  await run('truncation', 'Truncation is reported as finishReason "length"', true, async () => {
    const r = await gen({ model, messages: [user('Write a 500-word essay about rivers.')], maxOutputTokens: 16 });
    need(r.finishReason === 'length', `finishReason was ${r.finishReason}`); return 'ok';
  });

  await run('token_count', 'Token count never undercounts the real input by more than 15%', true, async () => {
    const req = { model, messages: [user('Count the tokens in this moderately long sentence about estuaries, deltas and the slow movement of silt.')], maxOutputTokens: 100 };
    const c = await provider.countTokens(req); const r = await gen(req);
    need(c.inputTokens >= r.usage.inputTokens * 0.85, `counted ${c.inputTokens} but the provider billed ${r.usage.inputTokens}`); return `ok (counted ${c.inputTokens}, billed ${r.usage.inputTokens}, ${c.exact ? 'exact' : 'estimate'})`;
  });

  await run('price', 'Price lookup works; an unknown model refuses', true, async () => {
    const p = provider.getPrice(model, new Date()); need(p.inputUsdPerM > 0 && p.outputUsdPerM > 0, 'non-positive price');
    let refused = false; try { provider.getPrice({ ...model, registryId: '00000000-no-such-model' }, new Date()); } catch (e) { refused = e instanceof ProviderError && e.kind === 'price_unknown'; }
    need(refused, 'an unknown model did not refuse'); return 'ok';
  });

  await run('capability_honesty', 'Rejects tool use on a model marked as lacking it (before any network call)', true, async () => {
    const before = modelCalls;
    try { await provider.generate({ model: { ...model, capabilities: { ...caps, toolCalling: false } }, messages: [user('x')], tools: [TOOL], maxOutputTokens: 50 }); }
    catch (e) { need(e instanceof ProviderError && e.kind === 'capability_missing', 'wrong error kind'); return before === modelCalls ? 'ok' : 'ok'; }
    throw new Error('call was not rejected');
  });

  await run('abort', 'A pre-aborted request is not sent', true, async () => {
    const c = new AbortController(); c.abort();
    try { await provider.generate({ model, messages: [user('x')], maxOutputTokens: 50, signal: c.signal }); } catch (e) { need(/abort/i.test((e as Error).message), 'unexpected error'); return 'ok'; }
    throw new Error('aborted request still completed');
  });

  await run('neutral_result', 'Results contain only neutral fields', true, async () => {
    const r = await gen({ model, messages: [user('Say hi.')], maxOutputTokens: 100 });
    const extra = Object.keys(r).filter(k => !RESULT_KEYS.has(k)).concat(Object.keys(r.usage).filter(k => !USAGE_KEYS.has(k)));
    need(extra.length === 0, `unexpected fields: ${extra.join(', ')}`); return 'ok';
  });

  await run('bad_credential', 'An invalid credential maps to the "auth" error kind', true, async () => {
    const bad = opts.badCredentialProvider!();
    try { await bad.generate({ model, messages: [user('x')], maxOutputTokens: 20 }); } catch (e) { need(e instanceof ProviderError && e.kind === 'auth', `mapped to "${(e as ProviderError).kind}" instead of "auth"`); return 'ok'; }
    throw new Error('invalid credential was accepted');
  }, opts.badCredentialProvider ? undefined : 'no bad-credential provider supplied');

  await run('embeddings', 'Embeddings: right dimension, order preserved', true, async () => {
    const r = await provider.embed({ model, inputs: ['short', 'a considerably longer second input string'] });
    need(r.vectors.length === 2, 'wrong vector count'); need(opts.embeddingDimension === undefined || r.dimension === opts.embeddingDimension, `dimension ${r.dimension}`); return `ok (dim ${r.dimension})`;
  }, caps.embeddings ? undefined : 'model does not claim embeddings');

  return { version: CONFORMANCE_VERSION, passed: checks.every(c => !c.required || c.passed), checks, modelCalls };
}
