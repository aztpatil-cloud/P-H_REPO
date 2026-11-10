import { httpGet, type HttpOpts } from './http';
import { normalizeDoi } from './normalize';
import { RateLimiter } from './cache';
import type { SearchOutcome, SearchRequest, SearchSource, SourceRecord, SourceType } from './types';

export interface OpenAlexOptions {
  apiKey?: string; mailto?: string; baseUrl?: string; fetch?: typeof fetch; limiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>; costPerCallUsd?: number;
}

// Verified against OpenAlex's authentication page (updated 3 Nov 2026): the key may be sent as a bearer token,
// which keeps it out of URLs and logs, and the page-size parameter is per_page. The `select` field list is
// still unverified against a live response; the first live run confirms it.
const SELECT = 'id,doi,display_name,publication_date,type,authorships,primary_location,open_access,abstract_inverted_index';

export function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string | undefined {
  if (!inv) return undefined;
  const words: string[] = [];
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
  const text = words.filter(w => w !== undefined).join(' ').trim();
  return text || undefined;
}

const TYPE_MAP: Record<string, SourceType> = {
  article: 'peer_reviewed_paper', review: 'review_article', letter: 'peer_reviewed_paper', 'book-chapter': 'peer_reviewed_paper',
  preprint: 'preprint', report: 'technical_report', standard: 'standard_regulatory',
};

export function mapWork(w: any): SourceRecord | null {
  const title = (w?.display_name ?? w?.title ?? '').toString().trim();
  if (!title) return null;
  const doi = w.doi ? normalizeDoi(String(w.doi)) ?? undefined : undefined;
  const pd: string | undefined = typeof w.publication_date === 'string' ? w.publication_date : undefined;
  return {
    sourceType: TYPE_MAP[w.type] ?? 'other',
    doi,
    url: w.primary_location?.landing_page_url || (doi ? `https://doi.org/${doi}` : undefined) || w.id,
    title,
    authors: (w.authorships ?? []).map((a: any) => a?.author?.display_name).filter(Boolean),
    publishedOn: pd && /^\d{4}-\d{2}-\d{2}$/.test(pd) ? pd : undefined,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    oaUrl: w.open_access?.oa_url || undefined,
    retrievedVia: 'openalex',
  };
}

export class OpenAlexAdapter implements SearchSource {
  readonly name = 'openalex';
  private f: typeof fetch; private base: string; private limiter: RateLimiter;
  constructor(private o: OpenAlexOptions = {}) {
    this.f = o.fetch ?? fetch; this.base = o.baseUrl ?? 'https://api.openalex.org';
    this.limiter = o.limiter ?? new RateLimiter(120);
  }
  async search(req: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome> {
    const p = new URLSearchParams({ search: req.query, per_page: String(Math.min(req.limit ?? 10, 50)), select: SELECT });
    if (req.yearFrom) p.set('filter', `from_publication_date:${req.yearFrom}-01-01`);
    if (this.o.mailto) p.set('mailto', this.o.mailto);
    await this.limiter.wait();
    const opts: HttpOpts = { fetch: this.f, sleep: this.o.sleep, signal, headers: this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : undefined };
    const json = await httpGet(`${this.base}/works?${p}`, opts, 'json');
    const records = (json?.results ?? []).map(mapWork).filter((r: SourceRecord | null): r is SourceRecord => r !== null);
    return { records, cacheHit: false, estimatedCostUsd: this.o.costPerCallUsd ?? 0 };
  }
}
