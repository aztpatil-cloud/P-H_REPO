import { describe, it, expect } from 'vitest';
import { MockProvider, text } from '../src/providers/mock';
import { ProviderError } from '../src/providers/errors';
import { costUsd, worstCaseCostUsd } from '../src/pricing';
import { MODEL, NO_TOOLS, prices, userMsg } from './fixtures';
import type { JsonSchema } from '../src/providers/types';

const schema: JsonSchema = { type: 'object', properties: { n: { type: 'integer' }, tag: { type: 'string', enum: ['a', 'b'] } }, required: ['n'] };
const base = { model: MODEL, messages: [userMsg('hi')], maxOutputTokens: 1000 };

describe('BaseProvider', () => {
  it('returns text, usage and latency', async () => {
    const p = new MockProvider(prices(), [text('hello', { inputTokens: 10, outputTokens: 5 })]);
    const r = await p.generate(base);
    expect(r.text).toBe('hello'); expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(r.finishReason).toBe('stop');
  });

  it('retries retryable errors then succeeds, honouring retry-after', async () => {
    const sleeps: number[] = [];
    const p = new MockProvider(prices(), [new ProviderError('rate_limit', 'x', { retryAfterMs: 1234 }), new ProviderError('server', 'y'), text('ok')],
      { sleep: async ms => { sleeps.push(ms); } });
    const r = await p.generate(base);
    expect(r.retries).toBe(2); expect(sleeps).toEqual([1234, 1000]);
  });

  it('does not retry auth errors and gives up after maxRetries', async () => {
    const auth = new MockProvider(prices(), [new ProviderError('auth', 'bad key'), text('never')]);
    await expect(auth.generate(base)).rejects.toMatchObject({ kind: 'auth' });
    expect(auth.calls).toHaveLength(1);
    const flaky = new MockProvider(prices(), [new ProviderError('server', 'down')], { maxRetries: 2 });
    await expect(flaky.generate(base)).rejects.toMatchObject({ kind: 'server' });
    expect(flaky.calls).toHaveLength(3);
  });

  it('structured output: valid JSON passes, code fences tolerated', async () => {
    const p = new MockProvider(prices(), [text('```json\n{"n":3,"tag":"a"}\n```')]);
    const r = await p.generate({ ...base, outputSchema: schema });
    expect(r.structured).toEqual({ n: 3, tag: 'a' }); expect(r.schemaFailures).toBe(0);
  });

  it('structured output: invalid is re-asked, failures counted, usage summed across attempts', async () => {
    const u = { inputTokens: 100, outputTokens: 20 };
    const p = new MockProvider(prices(), [text('{"n":"three"}', u), text('{"n":3}', u)]);
    const r = await p.generate({ ...base, outputSchema: schema });
    expect(r.structured).toEqual({ n: 3 }); expect(r.schemaFailures).toBe(1);
    expect(r.usage.inputTokens).toBe(200); expect(r.usage.outputTokens).toBe(40);
    expect(JSON.stringify(p.calls[1]!.messages)).toContain('previous output was invalid');
  });

  it('structured output: gives up with a typed error that still carries the spent usage and raw text', async () => {
    const p = new MockProvider(prices(), [text('not json', { inputTokens: 50, outputTokens: 10 })], { maxSchemaRetries: 1 });
    const err = await p.generate({ ...base, outputSchema: schema }).catch(e => e) as ProviderError;
    expect(err.kind).toBe('schema_failure'); expect(err.usage?.inputTokens).toBe(100); expect(err.raw).toBe('not json');
  });

  it('truncated structured output is a schema failure, not a silent partial', async () => {
    const p = new MockProvider(prices(), [{ text: '{"n":', toolCalls: [], finishReason: 'length', usage: { inputTokens: 5, outputTokens: 1000 } }]);
    await expect(p.generate({ ...base, outputSchema: schema })).rejects.toMatchObject({ kind: 'schema_failure' });
  });

  it('non-native structured output injects the schema into the prompt', async () => {
    const p = new MockProvider(prices(), [text('{"n":1}')], { native: false });
    await p.generate({ ...base, outputSchema: schema });
    const sent = p.calls[0]!;
    expect(sent.outputSchema).toBeUndefined();
    expect(JSON.stringify(sent.messages[0])).toContain('JSON Schema');
  });

  it('capability honesty: rejects tools / schema / embeddings on models without them', async () => {
    const p = new MockProvider(prices(), [text('x')]);
    const tool = { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } as JsonSchema };
    await expect(p.generate({ ...base, model: NO_TOOLS, tools: [tool] })).rejects.toMatchObject({ kind: 'capability_missing' });
    await expect(p.generate({ ...base, model: NO_TOOLS, outputSchema: schema })).rejects.toMatchObject({ kind: 'capability_missing' });
    await expect(p.embed({ model: NO_TOOLS, inputs: ['a'] })).rejects.toMatchObject({ kind: 'capability_missing' });
    expect(p.calls).toHaveLength(0);
  });

  it('rejects tools+schema together, oversize output, and context overflow before any call', async () => {
    const p = new MockProvider(prices(), [text('x')]);
    const tool = { name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } as JsonSchema };
    await expect(p.generate({ ...base, tools: [tool], outputSchema: schema })).rejects.toMatchObject({ kind: 'capability_missing' });
    await expect(p.generate({ ...base, maxOutputTokens: 9_000 })).rejects.toMatchObject({ kind: 'capability_missing' });
    await expect(p.generate({ ...base, messages: [userMsg('x'.repeat(400_000))] })).rejects.toMatchObject({ kind: 'context_length' });
    expect(p.calls).toHaveLength(0);
  });

  it('rejects schemas outside the supported subset', async () => {
    const p = new MockProvider(prices(), [text('x')]);
    await expect(p.generate({ ...base, outputSchema: { type: 'object', oneOf: [] } as any })).rejects.toThrow(/unsupported schema keyword/);
  });

  it('abort is respected and not retried', async () => {
    const ctrl = new AbortController(); ctrl.abort();
    const p = new MockProvider(prices(), [text('x')]);
    await expect(p.generate({ ...base, signal: ctrl.signal })).rejects.toThrow(/aborted/);
    expect(p.calls).toHaveLength(0);
  });

  it('token counting: exact when available, otherwise a conservative estimate', async () => {
    const exact = new MockProvider(prices(), [text('x')], { exactCount: 42 });
    expect(await exact.countTokens(base)).toEqual({ inputTokens: 42, exact: true });
    const est = new MockProvider(prices(), [text('x')]);
    const body = 'word '.repeat(1000);                                  // ~5000 chars
    const c = await est.countTokens({ ...base, messages: [userMsg(body)] });
    expect(c.exact).toBe(false); expect(c.inputTokens).toBeGreaterThanOrEqual(Math.ceil(5000 / 4));  // never below a 4-chars/token reality
  });
});

describe('pricing', () => {
  it('uses the price effective on the call date', () => {
    const p = new MockProvider(prices(), [text('x')]);
    expect(p.getPrice(MODEL, new Date('2026-12-31')).inputUsdPerM).toBe(1);
    expect(p.getPrice(MODEL, new Date('2027-01-01')).inputUsdPerM).toBe(2);
  });
  it('unknown or unverified price refuses', () => {
    const p = new MockProvider(prices(false), [text('x')]);
    expect(() => p.getPrice(MODEL, new Date('2026-11-08'))).toThrow(/not verified/);
    expect(() => p.getPrice({ ...MODEL, registryId: 'other' }, new Date())).toThrow(/no price/);
    try { p.getPrice(MODEL, new Date('2026-11-08')); } catch (e) { expect((e as ProviderError).kind).toBe('price_unknown'); }
  });
  it('computes cost incl. cached input and reasoning-inclusive output', () => {
    const price = { inputUsdPerM: 1, outputUsdPerM: 4, cachedInputUsdPerM: 0.1 };
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 400_000 }, price)).toBeCloseTo(0.6 + 0.04 + 2);
    expect(worstCaseCostUsd(1000, 2000, price, 0.15)).toBeGreaterThan(costUsd({ inputTokens: 1000, outputTokens: 2000 }, price));
  });
});
