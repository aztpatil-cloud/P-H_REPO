import { BaseProvider, type BaseOptions, type RawResult } from './base';
import { ProviderError } from './errors';
import type { PriceBook } from '../pricing';
import type { EmbedRequest, EmbedResult, GenerateRequest } from './types';

export type MockStep = RawResult | ProviderError | ((req: GenerateRequest, n: number) => RawResult | ProviderError);

export const text = (t: string, usage = { inputTokens: 100, outputTokens: 50 }): RawResult =>
  ({ text: t, toolCalls: [], finishReason: 'stop', usage });

/** Scripted provider for tests and offline development. Goes through BaseProvider, so retry and
 *  structured-output logic is exercised exactly as for a real adapter. */
export class MockProvider extends BaseProvider {
  protected readonly nativeStructuredOutput: boolean;
  readonly calls: GenerateRequest[] = [];
  private n = 0;

  constructor(priceBook: PriceBook, private script: MockStep[] | ((req: GenerateRequest, n: number) => RawResult | ProviderError),
              opts: BaseOptions & { native?: boolean; exactCount?: number } = {}) {
    super('mock', priceBook, { sleep: async () => {}, ...opts });
    this.nativeStructuredOutput = opts.native ?? true;
    this.exact = opts.exactCount ?? null;
  }
  private exact: number | null;

  protected async rawGenerate(req: GenerateRequest): Promise<RawResult> {
    this.calls.push(req);
    const i = this.n++;
    const step = typeof this.script === 'function' ? this.script(req, i) : this.script[Math.min(i, this.script.length - 1)];
    const out = typeof step === 'function' ? step(req, i) : step;
    if (!out) throw new ProviderError('unknown', 'mock script exhausted');
    if (out instanceof ProviderError) throw out;
    return out;
  }
  protected async rawEmbed(req: EmbedRequest): Promise<EmbedResult> {
    return { vectors: req.inputs.map((_, i) => [i, 1, 0]), dimension: 3, usage: { inputTokens: req.inputs.join('').length } };
  }
  protected override async rawCountTokens() { return this.exact; }
}
