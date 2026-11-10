import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../src/providers/gemini/adapter';
import { MockProvider, text } from '../src/providers/mock';
import { runConformance } from '../src/providers/conformance';
import { MODEL, prices } from './fixtures';

import { fakeVendor } from './fake-vendor';
const caps = { ...MODEL.capabilities };
const model = { ...MODEL, provider: 'x', capabilities: caps };

describe('conformance suite', () => {
  it('a faithful adapter passes every required check (including bad-credential mapping and embeddings)', async () => {
    const mk = (key: string) => new GeminiAdapter(prices(), { apiKey: key, fetch: fakeVendor(), sleep: async () => {} });
    const report = await runConformance(mk('good-key'), model, { badCredentialProvider: () => mk('wrong-key'), embeddingDimension: 4 });
    const failed = report.checks.filter(c => !c.passed);
    expect(failed, JSON.stringify(failed)).toEqual([]); expect(report.passed).toBe(true);
    expect(report.checks.map(c => c.id)).toEqual(['plain', 'system', 'structured', 'tools', 'no_tool_needed', 'truncation', 'token_count', 'price', 'capability_honesty', 'abort', 'neutral_result', 'bad_credential', 'embeddings']);
    expect(report.modelCalls).toBeLessThanOrEqual(12);                                                    // cheap
  });

  it('a provider that ignores tools and structure is caught, with reasons', async () => {
    const lazy = new MockProvider(prices(), () => text('just some words'));
    const report = await runConformance(lazy, { ...model, capabilities: { ...caps, embeddings: false } });
    const byId = Object.fromEntries(report.checks.map(c => [c.id, c]));
    expect(report.passed).toBe(false);
    expect(byId.system!.passed).toBe(false); expect(byId.tools!.passed).toBe(false); expect(byId.truncation!.passed).toBe(false);
    expect(byId.tools!.detail).toMatch(/did not call the tool/);
    expect(byId.plain!.passed).toBe(true); expect(byId.capability_honesty!.passed).toBe(true); expect(byId.price!.passed).toBe(true);
  });

  it('checks for capabilities a model does not claim are skipped, not failed', async () => {
    const m = { ...model, capabilities: { ...caps, toolCalling: false, structuredOutput: false, embeddings: false } };
    const report = await runConformance(new GeminiAdapter(prices(), { apiKey: 'good-key', fetch: fakeVendor(), sleep: async () => {} }), m);
    expect(report.checks.filter(c => c.skipped).map(c => c.id).sort()).toEqual(['bad_credential', 'embeddings', 'no_tool_needed', 'structured', 'tools']);
    expect(report.passed).toBe(true);
  });

  it('an invalid-key response is mapped to "auth" by the adapter (HTTP 400 form)', async () => {
    const a = new GeminiAdapter(prices(), { apiKey: 'nope', fetch: fakeVendor(), sleep: async () => {} });
    await expect(a.generate({ model, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], maxOutputTokens: 20 })).rejects.toMatchObject({ kind: 'auth' });
  });
});
