import { XMLParser } from 'fast-xml-parser';
import { httpGet } from './http';
import { normalizeDoi } from './normalize';
import { RateLimiter } from './cache';
import type { SearchOutcome, SearchRequest, SearchSource, SourceRecord } from './types';

export interface PubMedOptions { apiKey?: string; email?: string; baseUrl?: string; fetch?: typeof fetch; limiter?: RateLimiter; sleep?: (ms: number) => Promise<void> }

const xml = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', trimValues: true,
  isArray: (name) => ['PubmedArticle', 'AbstractText', 'Author', 'ArticleId', 'PublicationType'].includes(name),
});

/** Flattens text that may contain inline markup (<i>, <sub>…), which the parser returns as nested objects. */
function textOf(n: any): string {
  if (n == null) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(' ');
  return Object.entries(n).filter(([k]) => !k.startsWith('@_')).map(([, v]) => textOf(v)).join(' ');
}
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function monthNum(m: any): string | undefined {
  if (m == null) return undefined; const s = String(m).trim().toLowerCase();
  if (/^\d{1,2}$/.test(s)) return s.padStart(2, '0');
  return MONTHS[s.slice(0, 3)];
}

export function mapArticle(a: any): SourceRecord | null {
  const mc = a?.MedlineCitation; const art = mc?.Article; if (!art) return null;
  const title = clean(textOf(art.ArticleTitle)); if (!title) return null;
  const pmid = clean(textOf(mc.PMID));
  const abs = (art.Abstract?.AbstractText ?? []).map((t: any) => {
    const body = clean(textOf(t)); const label = typeof t === 'object' ? t['@_Label'] : undefined;
    return label ? `${label}: ${body}` : body;
  }).filter(Boolean).join('\n');
  const authors = (art.AuthorList?.Author ?? []).map((x: any) => clean(`${textOf(x.ForeName)} ${textOf(x.LastName)}`) || clean(textOf(x.CollectiveName))).filter(Boolean);
  const ids: any[] = a.PubmedData?.ArticleIdList?.ArticleId ?? [];
  const doiRaw = ids.find(i => i?.['@_IdType'] === 'doi'); const doi = doiRaw ? normalizeDoi(textOf(doiRaw)) ?? undefined : undefined;
  const ad = art.ArticleDate?.[0] ?? art.ArticleDate; const pd = art.Journal?.JournalIssue?.PubDate;
  let publishedOn: string | undefined;
  const y = clean(textOf(ad?.Year ?? pd?.Year)); const mo = monthNum(ad?.Month ?? pd?.Month); const d = clean(textOf(ad?.Day ?? pd?.Day));
  if (/^\d{4}$/.test(y)) publishedOn = mo ? (/^\d{1,2}$/.test(d) ? `${y}-${mo}-${d.padStart(2, '0')}` : `${y}-${mo}`) : y;
  const types: string[] = (art.PublicationTypeList?.PublicationType ?? []).map(textOf);
  return {
    sourceType: types.some(t => /preprint/i.test(t)) ? 'preprint' : types.some(t => /^(systematic )?review$/i.test(t)) ? 'review_article' : 'peer_reviewed_paper',
    doi, url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : undefined, title,
    authors, publishedOn, abstract: abs || undefined, retrievedVia: 'pubmed',
  };
}

export class PubMedAdapter implements SearchSource {
  readonly name = 'pubmed';
  private f: typeof fetch; private base: string; private limiter: RateLimiter;
  constructor(private o: PubMedOptions = {}) {
    this.f = o.fetch ?? fetch; this.base = o.baseUrl ?? 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
    this.limiter = o.limiter ?? new RateLimiter(o.apiKey ? 110 : 350);   // conservative; official limits to be re-verified
  }
  private common(p: URLSearchParams) {
    p.set('tool', 'ph-rd-agent'); if (this.o.email) p.set('email', this.o.email); if (this.o.apiKey) p.set('api_key', this.o.apiKey); return p;
  }
  async search(req: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome> {
    const sp = this.common(new URLSearchParams({ db: 'pubmed', term: req.query, retmax: String(Math.min(req.limit ?? 10, 50)), retmode: 'json' }));
    if (req.yearFrom) { sp.set('datetype', 'pdat'); sp.set('mindate', String(req.yearFrom)); sp.set('maxdate', '3000'); }
    await this.limiter.wait();
    const s = await httpGet(`${this.base}/esearch.fcgi?${sp}`, { fetch: this.f, sleep: this.o.sleep, signal }, 'json');
    const ids: string[] = s?.esearchresult?.idlist ?? [];
    if (ids.length === 0) return { records: [], cacheHit: false, estimatedCostUsd: 0 };
    const fp = this.common(new URLSearchParams({ db: 'pubmed', id: ids.join(','), retmode: 'xml', rettype: 'abstract' }));
    await this.limiter.wait();
    const body = await httpGet(`${this.base}/efetch.fcgi?${fp}`, { fetch: this.f, sleep: this.o.sleep, signal }, 'text');
    // Inline formatting (<i>, <sub>…) splits text nodes and the parser loses their order, so drop the tags first.
    const doc = xml.parse(body.replace(/<\/?(?:i|b|u|sub|sup|italic|bold|underline|sc)(?:\s[^>]*)?>/gi, ''));
    const arts: any[] = doc?.PubmedArticleSet?.PubmedArticle ?? [];
    return { records: arts.map(mapArticle).filter((r): r is SourceRecord => r !== null), cacheHit: false, estimatedCostUsd: 0 };
  }
}
