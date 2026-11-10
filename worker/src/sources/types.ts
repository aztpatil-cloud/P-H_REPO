export type SourceType = 'peer_reviewed_paper' | 'review_article' | 'preprint' | 'patent' | 'technical_report'
  | 'standard_regulatory' | 'company_web' | 'trade_press' | 'internal_doc' | 'other';

export interface SourceRecord {
  sourceType: SourceType;
  doi?: string;
  url?: string;
  title: string;
  authors?: string[];
  /** 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD': we never invent a month or day the source did not state. */
  publishedOn?: string;
  abstract?: string;
  oaUrl?: string;
  retrievedVia: string;
}

export interface SearchRequest { query: string; limit?: number; yearFrom?: number }
export interface SearchOutcome { records: SourceRecord[]; cacheHit: boolean; estimatedCostUsd: number }

export interface SearchSource {
  readonly name: string;
  search(req: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome>;
}
export interface DoiResolver {
  readonly name: string;
  lookupDoi(doi: string, signal?: AbortSignal): Promise<SourceRecord | null>;
}

export type SourceErrorKind = 'rate_limit' | 'auth' | 'timeout' | 'server' | 'not_found' | 'bad_response' | 'cache_miss' | 'call_limit';
export class SourceError extends Error {
  constructor(readonly kind: SourceErrorKind, message: string, readonly retryAfterMs?: number) { super(message); this.name = 'SourceError'; }
  get retryable() { return this.kind === 'rate_limit' || this.kind === 'timeout' || this.kind === 'server'; }
}
