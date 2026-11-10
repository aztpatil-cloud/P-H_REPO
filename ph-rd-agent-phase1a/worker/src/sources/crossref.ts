import { httpGet } from './http';
import { normalizeDoi } from './normalize';
import { RateLimiter } from './cache';
import type { DoiResolver, SourceRecord, SourceType } from './types';

export interface CrossrefOptions { mailto?: string; baseUrl?: string; fetch?: typeof fetch; limiter?: RateLimiter; sleep?: (ms: number) => Promise<void> }

const TYPE_MAP: Record<string, SourceType> = {
  'journal-article': 'peer_reviewed_paper', 'proceedings-article': 'peer_reviewed_paper', 'book-chapter': 'peer_reviewed_paper',
  'posted-content': 'preprint', report: 'technical_report', standard: 'standard_regulatory',
};

export function mapCrossref(m: any): SourceRecord | null {
  const title = (Array.isArray(m?.title) ? m.title[0] : m?.title)?.toString().replace(/<[^>]+>/g, '').trim();
  if (!title) return null;
  const dp: number[] | undefined = m.issued?.['date-parts']?.[0];
  const pad = (n: number) => String(n).padStart(2, '0');
  const publishedOn = dp?.[0] ? [String(dp[0]), dp[1] ? pad(dp[1]) : null, dp[1] && dp[2] ? pad(dp[2]) : null].filter(Boolean).join('-') : undefined;
  const isPreprint = m.type === 'posted-content' || m.subtype === 'preprint';
  return {
    sourceType: isPreprint ? 'preprint' : TYPE_MAP[m.type] ?? 'other',
    doi: m.DOI ? normalizeDoi(String(m.DOI)) ?? undefined : undefined,
    url: m.URL, title,
    authors: (m.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    publishedOn,
    abstract: typeof m.abstract === 'string' ? m.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined : undefined,
    retrievedVia: 'crossref',
  };
}

/** Authoritative DOI registry: used to VERIFY that a DOI exists and what it points to. */
export class CrossrefResolver implements DoiResolver {
  readonly name = 'crossref';
  private f: typeof fetch; private base: string; private limiter: RateLimiter;
  constructor(private o: CrossrefOptions = {}) {
    this.f = o.fetch ?? fetch; this.base = o.baseUrl ?? 'https://api.crossref.org'; this.limiter = o.limiter ?? new RateLimiter(200);
  }
  async lookupDoi(doi: string, signal?: AbortSignal): Promise<SourceRecord | null> {
    const d = normalizeDoi(doi); if (!d) return null;
    const q = this.o.mailto ? `?mailto=${encodeURIComponent(this.o.mailto)}` : '';
    await this.limiter.wait();
    const json = await httpGet(`${this.base}/works/${encodeURI(d)}${q}`, { fetch: this.f, sleep: this.o.sleep, signal, allow404: true }, 'json');
    return json ? mapCrossref(json.message) : null;
  }
}
