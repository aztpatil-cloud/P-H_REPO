import { PriceBook } from '../src/pricing';
import type { ModelRef } from '../src/providers/types';

export const MODEL: ModelRef = {
  registryId: 'm-1', provider: 'mock', providerModel: 'mock-model-1',
  capabilities: { contextTokens: 100_000, maxOutputTokens: 8_000, structuredOutput: true, toolCalling: true, embeddings: true, reasoningBilledAsOutput: true },
};
export const NO_TOOLS: ModelRef = { ...MODEL, capabilities: { ...MODEL.capabilities, toolCalling: false, structuredOutput: false, embeddings: false } };

export const prices = (verified = true) => new PriceBook([
  { modelRegistryId: 'm-1', inputUsdPerM: 1, outputUsdPerM: 4, effectiveFrom: '2026-01-01', verifiedAt: verified ? '2026-11-01T00:00:00Z' : null },
  { modelRegistryId: 'm-1', inputUsdPerM: 2, outputUsdPerM: 8, effectiveFrom: '2027-01-01', verifiedAt: '2026-11-01T00:00:00Z' },
]);

export const userMsg = (t: string) => ({ role: 'user' as const, parts: [{ type: 'text' as const, text: t }] });
