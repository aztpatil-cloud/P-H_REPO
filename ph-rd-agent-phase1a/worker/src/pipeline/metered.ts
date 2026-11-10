import type { BudgetGovernor, DenialReason } from '../budget';
import { usdToInr, costUsd, worstCaseCostUsd, type PriceBook } from '../pricing';
import { ProviderError } from '../providers/errors';
import type { EmbedRequest, EmbedResult, GenerateRequest, GenerateResult, ModelProvider, ModelRef, Price, TokenCount, Usage } from '../providers/types';

export class BudgetStop extends Error {
  constructor(readonly reason: DenialReason, readonly remainingInr: number) { super(`budget: ${reason}`); this.name = 'BudgetStop'; }
}

export interface CallRecord {
  investigationId: string | null; runStageId: string | null; task: string; model: ModelRef; isTest: boolean;
  usage: Usage; price: Price; fxRate: number; costUsd: number; costInr: number;
  finishReason: string | null; errorKind: string | null; schemaFailures: number; retries: number; latencyMs: number | null;
}
export interface CallSink { record(c: CallRecord): Promise<void> }

type Estimating = ModelProvider & { estimateTokens?: (req: GenerateRequest) => number };

/** Wraps any provider: reserve worst case -> call -> write the real cost to the ledger -> release. No provider can bypass it. */
export class MeteredProvider implements ModelProvider {
  readonly providerKey: string;
  constructor(private inner: Estimating, private o: {
    governor: BudgetGovernor; sink: CallSink; priceBook: PriceBook; fxRate: number; task: string; investigationId: string | null; runStageId: string | null;
    isTest: boolean; schemaRetries?: number; now?: () => Date;
  }) { this.providerKey = inner.providerKey; }

  getPrice(model: ModelRef, at: Date) { return this.o.priceBook.get(model, at); }
  countTokens(req: GenerateRequest): Promise<TokenCount> { return this.inner.countTokens(req); }
  embed(req: EmbedRequest): Promise<EmbedResult> { return this.inner.embed(req); }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const now = (this.o.now ?? (() => new Date()))();
    const price = this.o.priceBook.get(req.model, now);                      // unknown/unverified price refuses here
    const est = this.inner.estimateTokens?.(req) ?? Math.ceil(JSON.stringify(req.messages).length / 3.2);
    const attempts = req.outputSchema ? 1 + (this.o.schemaRetries ?? 2) : 1;
    const worstInr = usdToInr(worstCaseCostUsd(est, req.maxOutputTokens, price), this.o.fxRate) * attempts;
    const d = await this.o.governor.authorize(worstInr);
    if (!d.ok) throw new BudgetStop(d.reason, d.remainingInr);

    const base = { investigationId: this.o.investigationId, runStageId: this.o.runStageId, task: this.o.task, model: req.model, isTest: this.o.isTest, price, fxRate: this.o.fxRate };
    try {
      const res = await this.inner.generate(req);
      const usd = costUsd(res.usage, price);
      await this.o.sink.record({ ...base, usage: res.usage, costUsd: usd, costInr: usdToInr(usd, this.o.fxRate), finishReason: res.finishReason, errorKind: null, schemaFailures: res.schemaFailures, retries: res.retries, latencyMs: res.latencyMs });
      return res;
    } catch (e) {
      const spent = e instanceof ProviderError ? e.usage : undefined;        // failed structured attempts were still billed
      if (spent && (spent.inputTokens || spent.outputTokens)) {
        const usd = costUsd(spent, price);
        await this.o.sink.record({ ...base, usage: spent, costUsd: usd, costInr: usdToInr(usd, this.o.fxRate), finishReason: 'error', errorKind: (e as ProviderError).kind, schemaFailures: 0, retries: 0, latencyMs: null });
      }
      throw e;
    } finally {
      this.o.governor.settle(d.reservation);                                   // always AFTER the ledger write
    }
  }
}
