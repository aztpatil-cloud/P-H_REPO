import { describe, it, expect } from 'vitest';
import { verifyDoi } from '../src/verify/doi';
import { assertPublicUrl, isPublicIp, makeGuardedLookup, SsrfError } from '../src/verify/ssrf';
import { verifyUrl } from '../src/verify/url';
import { verifyQuote } from '../src/verify/quote';
import { combineSourceChecks, verifyFinding } from '../src/verify/finding';
import { containment, jaccard } from '../src/verify/similarity';
import { RetrievedSet } from '../src/sources/retrieved-set';
import { SourceError, type SourceRecord } from '../src/sources/types';

const resolver = (rec: SourceRecord | null | Error) => ({ name: 'r', lookupDoi: async () => { if (rec instanceof Error) throw rec; return rec; } });
const R = (title: string): SourceRecord => ({ sourceType: 'peer_reviewed_paper', title, retrievedVia: 't' });

describe('similarity', () => {
  it('ignores case, punctuation, stop words, diacritics', () => {
    expect(jaccard('The Crème Fraîche Study', 'creme fraiche study!')).toBe(1);
    expect(containment('Sugar reduction', 'Sugar Reduction in Juice | Journal of Food')).toBe(1);
    expect(jaccard('sugar', 'protein')).toBe(0);
  });
});

describe('verifyDoi', () => {
  const input = { doi: '10.1000/abc', storedTitle: 'Enzymatic sugar reduction in fruit juice' };
  it('verified when registered title matches', async () => { expect((await verifyDoi(input, resolver(R('Enzymatic Sugar Reduction in Fruit Juice')))).status).toBe('verified'); });
  it('failed when the DOI does not exist, is malformed, or points at a different paper', async () => {
    expect(await verifyDoi(input, resolver(null))).toMatchObject({ status: 'failed', reason: 'doi_not_found' });
    expect(await verifyDoi({ ...input, doi: 'not-a-doi' }, resolver(null))).toMatchObject({ status: 'failed', reason: 'malformed_doi' });
    expect(await verifyDoi(input, resolver(R('Quantum chromodynamics lattice methods')))).toMatchObject({ status: 'failed', reason: 'title_mismatch' });
  });
  it('a registry outage leaves the source unverified, never failed', async () => {
    expect(await verifyDoi(input, resolver(new SourceError('server', 'down')))).toMatchObject({ status: 'unverified', reason: 'registry_unavailable' });
  });
});

describe('SSRF protection', () => {
  it('classifies IPv4 ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1'])
      expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '172.32.0.1', '151.101.1.69', '100.63.255.255']) expect(isPublicIp(ip), ip).toBe(true);
  });
  it('classifies IPv6 ranges including mapped and NAT64 forms', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::808:808', '2001:db8::1', 'garbage'])
      expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPublicIp(ip), ip).toBe(true);
  });
  it('rejects bad schemes, credentials, odd ports, internal names, private literals and private DNS answers', async () => {
    const pub = async () => ['93.184.216.34'];
    for (const u of ['file:///etc/passwd', 'ftp://x.com/a', 'https://user:pw@example.com/', 'https://example.com:8080/', 'http://localhost/', 'http://db.internal/', 'http://x.local/',
      'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'not a url'])
      await expect(assertPublicUrl(u, pub), u).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl('https://evil.example/', async () => ['93.184.216.34', '10.0.0.5'])).rejects.toThrow(/non-public/);
    await expect(assertPublicUrl('https://nx.example/', async () => { throw new Error('nx'); })).rejects.toThrow(/resolve/);
    expect((await assertPublicUrl('https://example.com/a', pub)).hostname).toBe('example.com');
  });
  it('connect-time lookup blocks private answers (DNS rebinding)', async () => {
    const fake = (addr: string) => ((h: string, o: any, cb: any) => cb(null, [{ address: addr, family: 4 }])) as any;
    const bad = await new Promise<any>(r => makeGuardedLookup(fake('10.0.0.1'))('x.com', {}, (e: any) => r(e)));
    expect(bad).toBeInstanceOf(SsrfError);
    const good = await new Promise<any>(r => makeGuardedLookup(fake('8.8.8.8'))('x.com', { all: true }, (e: any, a: any) => r([e, a])));
    expect(good).toEqual([null, [{ address: '8.8.8.8', family: 4 }]]);
  });
});

function web(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  return { seen, fetch: (async (u: string) => { seen.push(u); const h = routes[u]; if (!h) throw new Error('unexpected ' + u); return h(); }) as unknown as typeof fetch };
}
const html = (title: string, status = 200, ct = 'text/html; charset=utf-8') => () => new Response(`<html><head><title>${title}</title></head><body>x</body></html>`, { status, headers: { 'content-type': ct } });
const pub = async () => ['93.184.216.34'];

describe('verifyUrl', () => {
  const inp = { url: 'https://example.com/paper', expectedTitle: 'Enzymatic sugar reduction in fruit juice' };
  it('verified: reachable and title matches (inside a longer page title)', async () => {
    const w = web({ [inp.url]: html('Enzymatic sugar reduction in fruit juice | Journal of Food') });
    expect(await verifyUrl(inp, { fetch: w.fetch, resolveHost: pub })).toMatchObject({ status: 'verified', reason: 'title_match' });
  });
  it('unverified (not failed): title differs, paywall/bot block, PDF', async () => {
    expect(await verifyUrl(inp, { fetch: web({ [inp.url]: html('Home') }).fetch, resolveHost: pub })).toMatchObject({ status: 'unverified', reason: 'reachable_title_mismatch' });
    expect(await verifyUrl(inp, { fetch: web({ [inp.url]: () => new Response('', { status: 403 }) }).fetch, resolveHost: pub })).toMatchObject({ status: 'unverified', reason: 'blocked_or_paywalled' });
    expect(await verifyUrl(inp, { fetch: web({ [inp.url]: () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }) }).fetch, resolveHost: pub })).toMatchObject({ status: 'unverified', reason: 'reachable_not_html' });
  });
  it('failed: 404/410, 500, network error, timeout-style abort', async () => {
    expect(await verifyUrl(inp, { fetch: web({ [inp.url]: () => new Response('', { status: 404 }) }).fetch, resolveHost: pub })).toMatchObject({ status: 'failed', reason: 'not_found' });
    expect(await verifyUrl(inp, { fetch: web({ [inp.url]: () => new Response('', { status: 500 }) }).fetch, resolveHost: pub })).toMatchObject({ status: 'failed', reason: 'http_error' });
    expect(await verifyUrl(inp, { fetch: (async () => { throw new TypeError('boom'); }) as any, resolveHost: pub })).toMatchObject({ status: 'failed', reason: 'unreachable' });
  });
  it('follows redirects with re-checks; a redirect INTO a private address is blocked', async () => {
    const ok = web({ [inp.url]: () => new Response('', { status: 301, headers: { location: '/final' } }), 'https://example.com/final': html('Enzymatic sugar reduction in fruit juice') });
    expect((await verifyUrl(inp, { fetch: ok.fetch, resolveHost: pub })).status).toBe('verified');
    const evil = web({ [inp.url]: () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }) });
    expect(await verifyUrl(inp, { fetch: evil.fetch, resolveHost: pub })).toMatchObject({ status: 'failed', reason: 'blocked_by_safety_check' });
    expect(evil.seen).toEqual([inp.url]);                                                   // the private address was never requested
    const loop = web({ [inp.url]: () => new Response('', { status: 302, headers: { location: inp.url } }) });
    expect(await verifyUrl(inp, { fetch: loop.fetch, resolveHost: pub, maxRedirects: 3 })).toMatchObject({ status: 'failed', reason: 'too_many_redirects' });
  });
  it('refuses a private literal outright without fetching', async () => {
    const w = web({});
    expect(await verifyUrl({ url: 'http://10.0.0.1/admin', expectedTitle: 'x' }, { fetch: w.fetch, resolveHost: pub })).toMatchObject({ status: 'failed', reason: 'blocked_by_safety_check' });
    expect(w.seen).toEqual([]);
  });
});

describe('verifyQuote', () => {
  const abs = 'Enzymatic treatment reduced sugar content by 30% in apple juice without affecting colour. The "treated" samples were rated sweeter by panellists.';
  it('verifies exact and typographically different quotes', () => {
    expect(verifyQuote('reduced sugar content by 30% in apple juice', abs).verified).toBe(true);
    expect(verifyQuote('REDUCED sugar content by 30% in apple-juice', abs).verified).toBe(true);
    expect(verifyQuote('The “treated” samples were rated sweeter', abs).verified).toBe(true);
  });
  it('ellipsis segments must all appear, in order', () => {
    expect(verifyQuote('Enzymatic treatment reduced … without affecting colour', abs).verified).toBe(true);
    expect(verifyQuote('without affecting colour ... Enzymatic treatment reduced', abs)).toMatchObject({ verified: false, reason: 'not_found' });
  });
  it('rejects fabricated, altered, too-short quotes and missing text', () => {
    expect(verifyQuote('reduced sugar content by 80% in apple juice', abs)).toMatchObject({ verified: false, reason: 'not_found' });
    expect(verifyQuote('sugar content', abs)).toMatchObject({ verified: false, reason: 'too_short' });
    expect(verifyQuote('reduced sugar content by 30% in apple juice', undefined)).toMatchObject({ verified: false, reason: 'no_text' });
  });
});

describe('finding verification', () => {
  const set = new RetrievedSet();
  set.add({ ...R('Paper A about enzymatic sugar reduction'), doi: '10.1000/a', abstract: 'Enzymatic treatment reduced sugar content by 30% in apple juice.' });
  set.add({ ...R('Paper B about fibre enrichment in bread'), doi: '10.1000/b' });
  const ok = { S1: 'verified', S2: 'verified' } as const;

  it('combineSourceChecks: DOI authority dominates; URL alone can verify; outages stay unverified', () => {
    const v = { status: 'verified', reason: '' } as const, f = { status: 'failed', reason: '' } as const, u = { status: 'unverified', reason: '' } as const;
    expect(combineSourceChecks({ doi: v, url: f })).toBe('verified');
    expect(combineSourceChecks({ doi: f, url: v })).toBe('failed');
    expect(combineSourceChecks({ url: v })).toBe('verified');
    expect(combineSourceChecks({ url: f })).toBe('failed');
    expect(combineSourceChecks({ doi: u, url: f })).toBe('unverified');
    expect(combineSourceChecks({})).toBe('unverified');
  });
  it('verified only when every source and every quote checks out', () => {
    const r = verifyFinding({ sourceRefs: ['S1', 'S2'], quotes: [{ ref: 'S1', quote: 'reduced sugar content by 30% in apple juice' }], sourceStatus: { ...ok } }, set);
    expect(r.status).toBe('verified'); expect(r.reasons).toEqual([]);
  });
  it('a fabricated reference caps the finding at partial and is reported', () => {
    const r = verifyFinding({ sourceRefs: ['S1', 'S77'], sourceStatus: { ...ok } }, set);
    expect(r).toMatchObject({ status: 'partial', rejectedRefs: ['S77'], validRefs: ['S1'] });
  });
  it('only fabricated references means unverified, never verified', () => {
    expect(verifyFinding({ sourceRefs: ['S9', '10.1000/a'], sourceStatus: {} }, set)).toMatchObject({ status: 'unverified', validRefs: [] });
    expect(verifyFinding({ sourceRefs: [], sourceStatus: {} }, set).status).toBe('unverified');
  });
  it('a failed quote caps at partial; a quote on a source with no stored text cannot verify', () => {
    expect(verifyFinding({ sourceRefs: ['S1'], quotes: [{ ref: 'S1', quote: 'reduced sugar content by 80% in apple juice' }], sourceStatus: { S1: 'verified' } }, set).status).toBe('partial');
    expect(verifyFinding({ sourceRefs: ['S2'], quotes: [{ ref: 'S2', quote: 'some quoted sentence from the paper body' }], sourceStatus: { S2: 'verified' } }, set).status).toBe('partial');
  });
  it('mixed or failed source statuses never produce verified', () => {
    expect(verifyFinding({ sourceRefs: ['S1', 'S2'], sourceStatus: { S1: 'verified', S2: 'unverified' } }, set).status).toBe('partial');
    expect(verifyFinding({ sourceRefs: ['S1', 'S2'], sourceStatus: { S1: 'verified', S2: 'failed' } }, set).status).toBe('partial');
    expect(verifyFinding({ sourceRefs: ['S1'], sourceStatus: { S1: 'failed' } }, set).status).toBe('unverified');
    expect(verifyFinding({ sourceRefs: ['S1'], sourceStatus: {} }, set).status).toBe('unverified');
  });
});
