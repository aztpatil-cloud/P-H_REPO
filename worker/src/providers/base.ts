import { ProviderError } from './errors';
import { PriceBook } from './../pricing';
import { assertSchemaSubset, extractJson, validateAgainstSchema } from './schema';
import type {
  EmbedRequest, EmbedResult, FinishReason, GenerateRequest, GenerateResult, Message, ModelProvider,
  ModelRef, Price, TokenCount, ToolCall, Usage,
} from './types';

export interface RawResult { text?: string; toolCalls: ToolCall[]; finishReason: FinishReason; usage: Usage }

export interface BaseOptions {
  maxRetries?: number;          // transport/server retries per attempt (default 3)
  maxSchemaRetries?: number;    // corrective re-asks for invalid structured output (default 2)
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  charsPerToken?: number;       // estimator, deliberately conservative (default 3.2)
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
});
const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });

/** Shared behaviour every adapter gets for free: capability checks, retries, structured-output validation. */
export abstract class BaseProvider implements ModelProvider {
  /** Adapters set this true when the vendor API enforces a schema natively. */
  protected abstract readonly nativeStructuredOutput: boolean;
  protected readonly o: Required<BaseOptions>;

  constructor(readonly providerKey: string, protected priceBook: PriceBook, opts: BaseOptions = {}) {
    this.o = {
      maxRetries: opts.maxRetries ?? 3,
      maxSchemaRetries: opts.maxSchemaRetries ?? 2,
      sleep: opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms))),
      now: opts.now ?? Date.now,
      charsPerToken: opts.charsPerToken ?? 3.2,
    };
  }

  /** ONE attempt. Must throw ProviderError for failures. */
  protected abstract rawGenerate(req: GenerateRequest): Promise<RawResult>;
  protected abstract rawEmbed(req: EmbedRequest): Promise<EmbedResult>;
  /** Optional exact count; return null to fall back to the estimator. */
  protected async rawCountTokens(_req: GenerateRequest): Promise<number | null> { return null; }

  getPrice(model: ModelRef, at: Date): Price { return this.priceBook.get(model, at); }

  estimateTokens(req: GenerateRequest): number {
    let chars = 0;
    for (const m of req.messages) for (const p of m.parts) {
      chars += p.type === 'text' ? p.text.length : JSON.stringify(p).length;
    }
    if (req.tools) chars += JSON.stringify(req.tools).length;
    if (req.outputSchema) chars += JSON.stringify(req.outputSchema).length;
    return Math.ceil(chars / this.o.charsPerToken);
  }

  async countTokens(req: GenerateRequest): Promise<TokenCount> {
    try {
      const exact = await this.rawCountTokens(req);
      if (exact !== null) return { inputTokens: exact, exact: true };
    } catch { /* estimator below */ }
    return { inputTokens: this.estimateTokens(req), exact: false };
  }

  private checkRequest(req: GenerateRequest) {
    const c = req.model.capabilities;
    if (req.tools?.length) {
      if (!c.toolCalling) throw new ProviderError('capability_missing', 'model does not support tool calling');
      for (const t of req.tools) assertSchemaSubset(t.inputSchema, `tool ${t.name}`);
    }
    if (req.outputSchema) {
      if (!c.structuredOutput) throw new ProviderError('capability_missing', 'model does not support structured output');
      assertSchemaSubset(req.outputSchema);
      if (req.tools?.length) throw new ProviderError('capability_missing', 'tools and outputSchema cannot be combined in one request; run the tool loop first, then a final structured call');
    }
    if (req.maxOutputTokens > c.maxOutputTokens) throw new ProviderError('capability_missing', `maxOutputTokens ${req.maxOutputTokens} exceeds model limit ${c.maxOutputTokens}`);
    const est = this.estimateTokens(req);
    if (est + req.maxOutputTokens > c.contextTokens) throw new ProviderError('context_length', `estimated ${est} input tokens + ${req.maxOutputTokens} output exceeds context ${c.contextTokens}`);
  }

  private async attempt(req: GenerateRequest): Promise<{ raw: RawResult; retries: number }> {
    let retries = 0;
    for (;;) {
      if (req.signal?.aborted) throw new ProviderError('unknown', 'aborted');
      try {
        return { raw: await this.rawGenerate(req), retries };
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || retries >= this.o.maxRetries) throw e;
        retries++;
        await this.o.sleep(e.retryAfterMs ?? Math.min(500 * 2 ** (retries - 1), 8000));
      }
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.checkRequest(req);
    const started = this.o.now();
    let working: GenerateRequest = req;
    if (req.outputSchema && !this.nativeStructuredOutput) {
      working = { ...req, outputSchema: undefined, messages: [this.schemaInstruction(req), ...req.messages] };
    }
    let usage = zeroUsage();
    let retries = 0;
    let schemaFailures = 0;

    for (;;) {
      let step: { raw: RawResult; retries: number };
      try { step = await this.attempt(working); }
      catch (e) {
        if (e instanceof ProviderError && !e.usage && usage.inputTokens + usage.outputTokens > 0)
          throw new ProviderError(e.kind, e.message, { ...e.opts, usage });
        throw e;
      }
      retries += step.retries;
      usage = addUsage(usage, step.raw.usage);
      const raw = step.raw;

      if (!req.outputSchema || raw.finishReason === 'blocked') {
        return { text: raw.text, toolCalls: raw.toolCalls, finishReason: raw.finishReason, usage, latencyMs: this.o.now() - started, retries, schemaFailures };
      }
      if (raw.finishReason === 'length') {
        throw new ProviderError('schema_failure', 'output truncated before the JSON was complete (raise maxOutputTokens)', { raw: raw.text, usage });
      }
      let problems: string[];
      let parsed: unknown;
      try {
        parsed = extractJson(raw.text ?? '');
        problems = validateAgainstSchema(parsed, req.outputSchema);
      } catch (e) { problems = [`not valid JSON: ${(e as Error).message}`]; }

      if (problems.length === 0) {
        return { text: raw.text, structured: parsed, toolCalls: [], finishReason: raw.finishReason, usage, latencyMs: this.o.now() - started, retries, schemaFailures };
      }
      schemaFailures++;
      if (schemaFailures > this.o.maxSchemaRetries) {
        throw new ProviderError('schema_failure', `structured output invalid after ${schemaFailures} attempts: ${problems.slice(0, 3).join('; ')}`, { raw: raw.text, usage });
      }
      working = {
        ...working,
        messages: [
          ...working.messages,
          { role: 'assistant', parts: [{ type: 'text', text: raw.text ?? '' }] },
          { role: 'user', parts: [{ type: 'text', text: `Your previous output was invalid: ${problems.slice(0, 5).join('; ')}. Return ONLY the corrected JSON value.` }] },
        ],
      };
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    if (!req.model.capabilities.embeddings) throw new ProviderError('capability_missing', 'model does not support embeddings');
    let retries = 0;
    for (;;) {
      try { return await this.rawEmbed(req); }
      catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || retries >= this.o.maxRetries) throw e;
        retries++;
        await this.o.sleep(e.retryAfterMs ?? Math.min(500 * 2 ** (retries - 1), 8000));
      }
    }
  }

  private schemaInstruction(req: GenerateRequest): Message {
    return { role: 'system', parts: [{ type: 'text', text:
      `Respond with ONLY a single JSON value that conforms to this JSON Schema. No prose, no code fences.\n${JSON.stringify(req.outputSchema)}` }] };
  }
}
