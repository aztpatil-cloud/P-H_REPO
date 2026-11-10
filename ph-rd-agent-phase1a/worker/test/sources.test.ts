import { describe, it, expect } from 'vitest';
import { normalizeDoi, normalizeTitle, normalizeUrl } from '../src/sources/normalize';
import { httpGet } from '../src/sources/http';
import { CachedDoiResolver, CachedSearchSource, CallLimitedSearchSource, MemoryToolCache, RateLimiter, searchHash } from '../src/sources/cache';
import { OpenAlexAdapter, reconstructAbstract } from '../src/sources/openalex';
import { PubMedAdapter } from '../src/sources/pubmed';
import { CrossrefResolver } from '../src/sources/crossref';
import { RetrievedSet } from '../src/sources/retrieved-set';
import { SourceError, type SearchSource, type SourceRecord } from '../src/sources/types';

const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });
const text = (b: string, status = 200) => new Response(b, { status });
const seq = (...rs: Response[]) => { const seen: string[] = []; let i = 0;
  return { seen, f: (async (u: string) => { seen.push(u); return rs[Math.min(i++, rs.length - 1)]!.clone(); }) as unknown as typeof fetch }; };
const noSleep = async () => {};

describe('normalizers', () => {
  it('DOI: strips prefixes, lower-cases, rejects junk', () => {
    expect(normalizeDoi('https://doi.org/10.1000/ABC.123')).toBe('10.1000/abc.123');
    expect(normalizeDoi('doi: 10.1000/xyz')).toBe('10.1000/xyz');
    expect(normalizeDoi('not a doi')).toBeNull();
  });
  it('URL: drops tracking params, fragment, www, default port, trailing slash; rejects non-http', () => {
    expect(normalizeUrl('HTTPS://www.Example.com:443/a/b/?utm_source=x&b=2&a=1#frag')).toBe('https://example.com/a/b?a=1&b=2');
    expect(normalizeUrl('ftp://example.com/x')).toBeNull(); expect(normalizeUrl('javascript:alert(1)')).toBeNull();
  });
  it('title: case, punctuation, diacritics collapse', () => { expect(normalizeTitle('Crème-Fraîche: A Study!')).toBe('creme fraiche a study'); });
});

describe('httpGet', () => {
  it('retries 429 (retry-after) and 5xx then succeeds; maps 404/auth/non-JSON', async () => {
    const sleeps: number[] = [];
    const a = seq(json({}, 429, { 'retry-after': '3' }), json({}, 503), json({ ok: 1 }));
    expect(await httpGet('http://x', { fetch: a.f, sleep: async m => { sleeps.push(m); } }, 'json')).toEqual({ ok: 1 });
    expect(sleeps).toEqual([3000, 1000]);
    await expect(httpGet('http://x', { fetch: seq(json({}, 404)).f }, 'json')).rejects.toMatchObject({ kind: 'not_found' });
    expect(await httpGet('http://x', { fetch: seq(json({}, 404)).f, allow404: true }, 'json')).toBeNull();
    await expect(httpGet('http://x', { fetch: seq(json({}, 401)).f }, 'json')).rejects.toMatchObject({ kind: 'auth' });
    await expect(httpGet('http://x', { fetch: seq(text('<html>')).f }, 'json')).rejects.toMatchObject({ kind: 'bad_response' });
  });
  it('gives up after maxRetries', async () => {
    const a = seq(json({}, 500));
    await expect(httpGet('http://x', { fetch: a.f, sleep: noSleep, maxRetries: 1 }, 'json')).rejects.toMatchObject({ kind: 'server' });
    expect(a.seen).toHaveLength(2);
  });
});

const rec = (title: string, extra: Partial<SourceRecord> = {}): SourceRecord => ({ sourceType: 'peer_reviewed_paper', title, retrievedVia: 't', ...extra });
class Fake implements SearchSource { name = 'fake'; calls = 0; constructor(private out: SourceRecord[] = [rec('A')]) {}
  async search() { this.calls++; return { records: this.out, cacheHit: false, estimatedCostUsd: 0 }; } }

describe('cache, limits, rate limiter', () => {
  it('search hash ignores case/spacing and never depends on the model', () => {
    expect(searchHash('x', { query: ' Palm  Oil ' })).toBe(searchHash('x', { query: 'palm oil', limit: 10 }));
    expect(searchHash('x', { query: 'palm oil' })).not.toBe(searchHash('y', { query: 'palm oil' }));
  });
  it('shared mode: second call is a free cache hit; TTL expiry refetches', async () => {
    let t = 0; const cache = new MemoryToolCache(() => t); const inner = new Fake();
    const s = new CachedSearchSource(inner, cache, { ttlSeconds: 60, now: () => t });
    expect((await s.search({ query: 'q' })).cacheHit).toBe(false);
    const hit = await s.search({ query: 'q' }); expect(hit.cacheHit).toBe(true); expect(hit.estimatedCostUsd).toBe(0); expect(inner.calls).toBe(1);
    t = 61_000; await s.search({ query: 'q' }); expect(inner.calls).toBe(2);
  });
  it('replay mode serves stale entries and errors on a miss, never calling the live source', async () => {
    let t = 0; const cache = new MemoryToolCache(() => t); const inner = new Fake();
    await new CachedSearchSource(inner, cache, { ttlSeconds: 1, now: () => t }).search({ query: 'q' });
    t = 10_000_000; const replay = new CachedSearchSource(inner, cache, { ttlSeconds: 1, mode: 'replay', now: () => t });
    expect((await replay.search({ query: 'q' })).cacheHit).toBe(true);
    await expect(replay.search({ query: 'other' })).rejects.toMatchObject({ kind: 'cache_miss' });
    expect(inner.calls).toBe(1);
  });
  it('DOI lookups cache null results too', async () => {
    let calls = 0; const r = { name: 'r', lookupDoi: async () => { calls++; return null; } };
    const c = new CachedDoiResolver(r, new MemoryToolCache(), { ttlSeconds: 60 });
    expect(await c.lookupDoi('10.1/a')).toBeNull(); expect(await c.lookupDoi('10.1/A')).toBeNull(); expect(calls).toBe(1);
  });
  it('call limit counts live calls only (placed inside the cache)', async () => {
    const limited = new CallLimitedSearchSource(new Fake(), 2); const s = new CachedSearchSource(limited, new MemoryToolCache(), { ttlSeconds: 60 });
    await s.search({ query: 'a' }); await s.search({ query: 'a' }); await s.search({ query: 'b' });
    await expect(s.search({ query: 'c' })).rejects.toMatchObject({ kind: 'call_limit' });
  });
  it('rate limiter spaces calls', async () => {
    let t = 1000; const slept: number[] = []; const rl = new RateLimiter(300, () => t, async ms => { slept.push(ms); t += ms; });
    await rl.wait(); await rl.wait(); await rl.wait();
    expect(slept).toEqual([300, 300]);
  });
});

describe('OpenAlex', () => {
  const work = (o: any = {}) => ({ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/ABC', display_name: 'Enzymatic sugar reduction in juice', publication_date: '2021-05-04',
    type: 'article', authorships: [{ author: { display_name: 'A. Rao' } }], primary_location: { landing_page_url: 'https://journal.example/abc' },
    open_access: { oa_url: 'https://oa.example/abc.pdf' }, abstract_inverted_index: { Sugar: [0], reduction: [1], works: [2] }, ...o });
  it('reconstructs abstracts from the inverted index', () => { expect(reconstructAbstract({ b: [1], a: [0], c: [2] })).toBe('a b c'); expect(reconstructAbstract(null)).toBeUndefined(); });
  it('maps works to records and builds the request (key as bearer header, never in the URL; select; year filter)', async () => {
    const headersSeen: any[] = [];
    const a0 = seq(json({ results: [work(), work({ display_name: '', id: 'x' }), work({ type: 'preprint', doi: null, display_name: 'Preprint thing', primary_location: null })] }));
    const a = { seen: a0.seen, f: (async (u: string, init: any) => { headersSeen.push(init?.headers); return a0.f(u, init); }) as unknown as typeof fetch };
    const out = await new OpenAlexAdapter({ fetch: a.f, apiKey: 'K', mailto: 'a@b.c', limiter: new RateLimiter(0) }).search({ query: 'sugar reduction', limit: 5, yearFrom: 2015 });
    expect(out.records).toHaveLength(2);
    expect(out.records[0]).toMatchObject({ doi: '10.1000/abc', sourceType: 'peer_reviewed_paper', publishedOn: '2021-05-04', url: 'https://journal.example/abc',
      abstract: 'Sugar reduction works', oaUrl: 'https://oa.example/abc.pdf', retrievedVia: 'openalex' });
    expect(out.records[1]).toMatchObject({ sourceType: 'preprint', url: 'https://openalex.org/W1' });
    expect(a.seen[0]).toContain('search=sugar+reduction'); expect(a.seen[0]).toContain('per_page=5'); expect(a.seen[0]).not.toContain('K&'); expect(a.seen[0]).not.toContain('api_key'); expect(headersSeen[0]).toEqual({ authorization: 'Bearer K' });
    expect(a.seen[0]).toContain('from_publication_date%3A2015-01-01');
  });
  it('empty results are an explicit empty outcome', async () => {
    expect((await new OpenAlexAdapter({ fetch: seq(json({ results: [] })).f, limiter: new RateLimiter(0) }).search({ query: 'zzz' })).records).toEqual([]);
  });
});

const ESEARCH = { esearchresult: { idlist: ['111', '222'] } };
const EFETCH = `<?xml version="1.0"?><PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID Version="1">111</PMID><Article>
 <Journal><JournalIssue><PubDate><Year>2020</Year><Month>Mar</Month></PubDate></JournalIssue></Journal>
 <ArticleTitle>Effect of <i>Lactobacillus</i> on sodium taste</ArticleTitle>
 <Abstract><AbstractText Label="BACKGROUND">Salt is a problem.</AbstractText><AbstractText Label="RESULTS">Taste improved.</AbstractText></Abstract>
 <AuthorList><Author><LastName>Singh</LastName><ForeName>Priya</ForeName></Author></AuthorList>
 <PublicationTypeList><PublicationType>Journal Article</PublicationType></PublicationTypeList></Article></MedlineCitation>
 <PubmedData><ArticleIdList><ArticleId IdType="pubmed">111</ArticleId><ArticleId IdType="doi">10.2000/Food.1</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID>222</PMID><Article>
 <ArticleDate><Year>2022</Year><Month>11</Month><Day>7</Day></ArticleDate>
 <ArticleTitle>A preprint on fibre</ArticleTitle>
 <PublicationTypeList><PublicationType>Preprint</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

describe('PubMed', () => {
  it('two-step search then fetch; parses abstract sections, markup, ids, partial dates, preprints', async () => {
    const a = seq(json(ESEARCH), text(EFETCH));
    const out = await new PubMedAdapter({ fetch: a.f, apiKey: 'K', email: 'a@b.c', limiter: new RateLimiter(0) }).search({ query: 'sodium taste', limit: 2 });
    expect(a.seen[0]).toContain('esearch.fcgi'); expect(a.seen[1]).toContain('efetch.fcgi'); expect(a.seen[1]).toContain('id=111%2C222');
    expect(out.records[0]).toMatchObject({ title: 'Effect of Lactobacillus on sodium taste', doi: '10.2000/food.1', publishedOn: '2020-03',
      url: 'https://pubmed.ncbi.nlm.nih.gov/111/', authors: ['Priya Singh'], sourceType: 'peer_reviewed_paper', abstract: 'BACKGROUND: Salt is a problem.\nRESULTS: Taste improved.' });
    expect(out.records[1]).toMatchObject({ sourceType: 'preprint', publishedOn: '2022-11-07' }); expect(out.records[1]!.abstract).toBeUndefined();
  });
  it('no hits means no second request', async () => {
    const a = seq(json({ esearchresult: { idlist: [] } }));
    expect((await new PubMedAdapter({ fetch: a.f, limiter: new RateLimiter(0) }).search({ query: 'nothing' })).records).toEqual([]);
    expect(a.seen).toHaveLength(1);
  });
});

describe('Crossref', () => {
  const msg = { message: { DOI: '10.1000/ABC', title: ['Enzymatic <i>sugar</i> reduction'], author: [{ given: 'A', family: 'Rao' }], issued: { 'date-parts': [[2021, 5]] }, type: 'journal-article', URL: 'https://doi.org/10.1000/abc', abstract: '<jats:p>Hello <b>there</b></jats:p>' } };
  it('maps a DOI record, strips markup, keeps partial dates', async () => {
    const r = await new CrossrefResolver({ fetch: seq(json(msg)).f, limiter: new RateLimiter(0), mailto: 'a@b.c' }).lookupDoi('https://doi.org/10.1000/ABC');
    expect(r).toMatchObject({ doi: '10.1000/abc', title: 'Enzymatic sugar reduction', publishedOn: '2021-05', abstract: 'Hello there', sourceType: 'peer_reviewed_paper' });
  });
  it('404 means not found (null); malformed DOI never hits the network', async () => {
    const a = seq(json({}, 404));
    const c = new CrossrefResolver({ fetch: a.f, limiter: new RateLimiter(0) });
    expect(await c.lookupDoi('10.1000/missing')).toBeNull(); expect(await c.lookupDoi('garbage')).toBeNull(); expect(a.seen).toHaveLength(1);
  });
});

describe('RetrievedSet', () => {
  it('assigns handles, collapses duplicates by DOI / URL / title, merges missing fields', () => {
    const s = new RetrievedSet();
    const a = s.add(rec('Enzymatic sugar reduction in fruit juice', { doi: '10.1000/A', url: 'https://x.org/a?utm_source=z' }));
    expect(a).toEqual({ handle: 'S1', created: true });
    expect(s.add(rec('Different title', { doi: 'https://doi.org/10.1000/a', abstract: 'abs' }))).toEqual({ handle: 'S1', created: false });
    expect(s.add(rec('Another', { url: 'https://www.x.org/a' })).handle).toBe('S1');
    expect(s.add(rec('enzymatic sugar-reduction in fruit juice!')).handle).toBe('S1');
    expect(s.resolve('S1')!.abstract).toBe('abs');
    expect(s.add(rec('Unrelated paper about fibre', { doi: '10.9000/z' })).handle).toBe('S2'); expect(s.size).toBe(2);
  });
  it('rejects anything the model cites that was not retrieved (fabricated handles, raw DOIs, URLs)', () => {
    const s = new RetrievedSet(); s.add(rec('Real paper about something', { doi: '10.1000/a' }));
    expect(s.checkRefs(['S1', 'S1', 'S9', '10.1000/a', 'https://made.up/paper'])).toEqual({ valid: ['S1'], rejected: ['S9', '10.1000/a', 'https://made.up/paper'] });
  });
});
