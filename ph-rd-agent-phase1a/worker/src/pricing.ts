import { ProviderError } from './providers/errors';
import type { ModelRef, Price, Usage } from './providers/types';

export interface PriceRow {
  modelRegistryId: string;
  inputUsdPerM: number;
  outputUsdPerM: number;
  cachedInputUsdPerM?: number;
  effectiveFrom: string;       // YYYY-MM-DD
  verifiedAt: string | null;   // null = a human has not re-checked it
}

/** Effective-dated price lookup. Unknown or unverified prices REFUSE the call. */
export class PriceBook {
  constructor(private rows: PriceRow[], private opts: { requireVerified: boolean } = { requireVerified: true }) {}

  get(model: ModelRef, at: Date): Price {
    const day = at.toISOString().slice(0, 10);
    const candidates = this.rows
      .filter(r => r.modelRegistryId === model.registryId && r.effectiveFrom <= day)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    const row = candidates[0];
    if (!row) throw new ProviderError('price_unknown', `no price on file for model ${model.registryId} on ${day}`);
    if (this.opts.requireVerified && !row.verifiedAt)
      throw new ProviderError('price_unknown', `price for model ${model.registryId} effective ${row.effectiveFrom} is not verified`);
    return { inputUsdPerM: row.inputUsdPerM, outputUsdPerM: row.outputUsdPerM, cachedInputUsdPerM: row.cachedInputUsdPerM };
  }
}

export function costUsd(usage: Usage, price: Price): number {
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cachedRate = price.cachedInputUsdPerM ?? price.inputUsdPerM;
  return ((usage.inputTokens - cached) * price.inputUsdPerM + cached * cachedRate + usage.outputTokens * price.outputUsdPerM) / 1e6;
}

/** Worst-case cost before a call: estimated input (with margin) plus the full output allowance. */
export function worstCaseCostUsd(estInputTokens: number, maxOutputTokens: number, price: Price, margin = 0.15): number {
  return costUsd({ inputTokens: Math.ceil(estInputTokens * (1 + margin)), outputTokens: maxOutputTokens }, price);
}

export const usdToInr = (usd: number, fx: number) => usd * fx;
