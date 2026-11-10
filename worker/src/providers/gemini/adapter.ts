import { BaseProvider, type BaseOptions, type RawResult } from '../base';
import { ProviderError } from '../errors';
import type { PriceBook } from '../../pricing';
import type { AvailableModel, EmbedRequest, EmbedResult, GenerateRequest } from '../types';
import { buildGenerateBody, parseGenerateResponse, toGeminiContents } from './translate';

export interface GeminiOptions extends BaseOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;   // injectable for tests
}

export class GeminiAdapter extends BaseProvider {
  protected readonly nativeStructuredOutput = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly f: typeof fetch;
  private idCounter = 0;

  constructor(priceBook: PriceBook, opts: GeminiOptions) {
    super('gemini', priceBook, opts);
    if (!opts.apiKey) throw new Error('GeminiAdapter requires an apiKey (server-side only)');
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.f = opts.fetch ?? fetch;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    let res: Response;
    try {
      res = await this.f(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new ProviderError('unknown', 'aborted');
      if ((e as Error).name === 'AbortError') throw new ProviderError('timeout', 'request timed out');
      throw new ProviderError('server', `network error: ${(e as Error).message}`);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }

    const raw = await res.text();
    if (res.ok) { try { return JSON.parse(raw); } catch { throw new ProviderError('server', 'unparseable response body', { raw }); } }
    throw this.mapHttpError(res.status, raw, res.headers.get('retry-after'));
  }

  private mapHttpError(status: number, raw: string, retryAfter: string | null): ProviderError {
    let msg = raw.slice(0, 300);
    try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch { /* keep raw */ }
    const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
    if (status === 429) return new ProviderError('rate_limit', msg, { retryAfterMs, raw });
    if (status === 401 || status === 403) return new ProviderError('auth', msg, { raw });
    // This API reports an invalid key as HTTP 400 with an API_KEY_INVALID reason, not 401 (from memory; the live conformance run confirms).
    if (status === 400 && /api key (not valid|expired)|API_KEY_INVALID/i.test(`${msg} ${raw}`)) return new ProviderError('auth', msg, { raw });
    if (status === 408 || status === 504) return new ProviderError('timeout', msg, { raw });
    if (status >= 500) return new ProviderError('server', msg, { raw });
    if (status === 400 && /token/i.test(msg) && /(exceed|limit|too long|too large)/i.test(msg)) return new ProviderError('context_length', msg, { raw });
    return new ProviderError('unknown', `HTTP ${status}: ${msg}`, { raw });
  }

  protected async rawGenerate(req: GenerateRequest): Promise<RawResult> {
    const json = await this.post(`/models/${req.model.providerModel}:generateContent`, buildGenerateBody(req), req.signal);
    return parseGenerateResponse(json, () => `call_${++this.idCounter}`);
  }

  protected override async rawCountTokens(req: GenerateRequest): Promise<number | null> {
    const { systemInstruction, contents } = toGeminiContents(req.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    const json = await this.post(`/models/${req.model.providerModel}:countTokens`, body, req.signal);
    return typeof json?.totalTokens === 'number' ? json.totalTokens : null;
  }

  async listModels(): Promise<AvailableModel[]> {
    const out: AvailableModel[] = []; let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response;
      try { res = await this.f(`${this.baseUrl}/models?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { headers: { 'x-goog-api-key': this.apiKey }, signal: ctrl.signal }); }
      catch (e) { throw new ProviderError('server', `network error: ${(e as Error).message}`); } finally { clearTimeout(timer); }
      const raw = await res.text(); if (!res.ok) throw this.mapHttpError(res.status, raw, res.headers.get('retry-after'));
      const json = JSON.parse(raw);
      for (const m of json.models ?? []) {
        const methods: string[] = m.supportedGenerationMethods ?? [];
        out.push({ providerModel: String(m.name).replace(/^models\//, ''), displayName: m.displayName ?? m.name, contextTokens: m.inputTokenLimit ?? null, maxOutputTokens: m.outputTokenLimit ?? null,
          supportsGeneration: methods.includes('generateContent'), supportsEmbeddings: methods.some(x => /embed/i.test(x)) });
      }
      token = json.nextPageToken; if (!token) break;
    }
    return out;
  }

  protected async rawEmbed(req: EmbedRequest): Promise<EmbedResult> {
    const taskType = req.purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const json = await this.post(`/models/${req.model.providerModel}:batchEmbedContents`, {
      requests: req.inputs.map(t => ({ model: `models/${req.model.providerModel}`, content: { parts: [{ text: t }] }, taskType })),
    }, req.signal);
    const vectors: number[][] = (json?.embeddings ?? []).map((e: { values: number[] }) => e.values);
    if (vectors.length !== req.inputs.length) throw new ProviderError('server', 'embedding count mismatch');
    return { vectors, dimension: vectors[0]?.length ?? 0, usage: { inputTokens: Math.ceil(req.inputs.join('').length / this.o.charsPerToken) } };
  }
}
