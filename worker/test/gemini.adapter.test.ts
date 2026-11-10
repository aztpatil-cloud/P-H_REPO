import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../src/providers/gemini/adapter';
import { MODEL, prices, userMsg } from './fixtures';
import type { JsonSchema } from '../src/providers/types';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const err = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers });

function adapter(responses: Response[], seen: { url: string; body: any; headers: any }[] = []) {
  let i = 0;
  const fetchFake = (async (url: string, init: any) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return responses[Math.min(i++, responses.length - 1)]!.clone();
  }) as unknown as typeof fetch;
  return new GeminiAdapter(prices(), { apiKey: 'test-key', fetch: fetchFake, sleep: async () => {} });
}
const gOk = (text: string, extra: any = {}) => ok({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 50, cachedContentTokenCount: 20 }, ...extra,
});
const base = { model: MODEL, messages: [userMsg('hi')], maxOutputTokens: 500 };
const schema: JsonSchema = { type: 'object', properties: { n: { type: 'integer' }, s: { type: 'string', nullable: true, enum: ['a'] } }, required: ['n'] };

describe('GeminiAdapter translation', () => {
  it('sends system parts as systemInstruction, key in header (never URL), model from registry', async () => {
    const seen: any[] = [];
    await adapter([gOk('yo')], seen).generate({ ...base, messages: [
      { role: 'system', parts: [{ type: 'text', text: 'S1' }, { type: 'text', text: 'S2' }] }, userMsg('hello')] });
    const s = seen[0];
    expect(s.url).toContain('/models/mock-model-1:generateContent'); expect(s.url).not.toContain('test-key');
    expect(s.headers['x-goog-api-key']).toBe('test-key');
    expect(s.body.systemInstruction.parts).toEqual([{ text: 'S1' }, { text: 'S2' }]);
    expect(s.body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
    expect(s.body.generationConfig.maxOutputTokens).toBe(500);
  });

  it('translates our schema to the vendor schema (uppercase types, enum, nullable, required)', async () => {
    const seen: any[] = [];
    await adapter([gOk('{"n":1}')], seen).generate({ ...base, outputSchema: schema });
    const gc = seen[0].body.generationConfig;
    expect(gc.responseMimeType).toBe('application/json');
    expect(gc.responseSchema).toEqual({ type: 'OBJECT', required: ['n'],
      properties: { n: { type: 'INTEGER' }, s: { type: 'STRING', nullable: true, enum: ['a'] } } });
  });

  it('maps usage: reasoning tokens are billed as output; cached tokens reported', async () => {
    const r = await adapter([gOk('yo')]).generate(base);
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 80, cachedInputTokens: 20, reasoningTokens: 50 });
  });

  it('tool round trip: declarations out, functionCall in (ids generated), results sent as user turn', async () => {
    const seen: any[] = [];
    const a = adapter([ok({ candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), gOk('done')], seen);
    const tool = { name: 'search', description: 'd', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } as JsonSchema };
    const r1 = await a.generate({ ...base, tools: [tool] });
    expect(r1.finishReason).toBe('tool_calls'); expect(r1.toolCalls).toEqual([{ id: 'call_1', name: 'search', args: { q: 'x' } }]);
    expect(seen[0].body.tools[0].functionDeclarations[0]).toMatchObject({ name: 'search', parameters: { type: 'OBJECT' } });
    await a.generate({ ...base, tools: [tool], messages: [userMsg('hi'),
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'search', args: { q: 'x' } }] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'call_1', name: 'search', result: ['r1', 'r2'] }] }] });
    const c = seen[1].body.contents;
    expect(c[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] });
    expect(c[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'search', response: { result: ['r1', 'r2'] } } }] });
  });

  it('finish reasons: length, safety and prompt blocks map to neutral values', async () => {
    const len = await adapter([ok({ candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: {} })]).generate(base);
    expect(len.finishReason).toBe('length');
    const safe = await adapter([ok({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }], usageMetadata: {} })]).generate(base);
    expect(safe.finishReason).toBe('blocked');
    const pf = await adapter([ok({ promptFeedback: { blockReason: 'OTHER' }, usageMetadata: { promptTokenCount: 4 } })]).generate(base);
    expect(pf.finishReason).toBe('blocked'); expect(pf.usage.inputTokens).toBe(4);
  });

  it('ignores thought-summary parts in the visible text', async () => {
    const r = await adapter([ok({ candidates: [{ content: { parts: [{ text: 'secret thinking', thought: true }, { text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: {} })]).generate(base);
    expect(r.text).toBe('answer');
  });
});

describe('GeminiAdapter errors', () => {
  const kind = async (res: Response) => (await adapter([res]).generate(base).catch(e => e)).kind;
  it('maps HTTP failures to neutral error kinds', async () => {
    expect(await kind(err(401, 'bad key'))).toBe('auth');
    expect(await kind(err(403, 'denied'))).toBe('auth');
    expect(await kind(err(504, 'gateway'))).toBe('timeout');
    expect(await kind(err(400, 'The input token count exceeds the maximum number of tokens allowed'))).toBe('context_length');
    expect(await kind(err(400, 'Invalid argument'))).toBe('unknown');
  });
  it('retries 429 (using retry-after) and 5xx, then succeeds', async () => {
    const seen: any[] = [];
    const r = await adapter([err(429, 'slow down', { 'retry-after': '2' }), err(503, 'busy'), gOk('fine')], seen).generate(base);
    expect(r.text).toBe('fine'); expect(r.retries).toBe(2); expect(seen).toHaveLength(3);
  });
  it('network failure is a retryable server error', async () => {
    const a = new GeminiAdapter(prices(), { apiKey: 'k', maxRetries: 1, sleep: async () => {},
      fetch: (async () => { throw new TypeError('fetch failed'); }) as any });
    await expect(a.generate(base)).rejects.toMatchObject({ kind: 'server' });
  });
  it('requires an API key', () => { expect(() => new GeminiAdapter(prices(), { apiKey: '' })).toThrow(/apiKey/); });
});

describe('GeminiAdapter tokens, embeddings, price', () => {
  it('uses the vendor count endpoint when it works, estimator when it fails', async () => {
    const seen: any[] = [];
    expect(await adapter([ok({ totalTokens: 77 })], seen).countTokens(base)).toEqual({ inputTokens: 77, exact: true });
    expect(seen[0].url).toContain(':countTokens');
    const fallback = await adapter([err(500, 'oops')]).countTokens(base);
    expect(fallback.exact).toBe(false);
  });
  it('batch embeds with the right task type and preserves order', async () => {
    const seen: any[] = [];
    const r = await adapter([ok({ embeddings: [{ values: [1, 2, 3] }, { values: [4, 5, 6] }] })], seen)
      .embed({ model: MODEL, inputs: ['a', 'b'], purpose: 'query' });
    expect(r.vectors).toEqual([[1, 2, 3], [4, 5, 6]]); expect(r.dimension).toBe(3);
    expect(seen[0].body.requests[0].taskType).toBe('RETRIEVAL_QUERY');
  });
  it('prices come from the registry price book', () => {
    expect(adapter([gOk('x')]).getPrice(MODEL, new Date('2026-11-08')).outputUsdPerM).toBe(4);
  });
});
