import { createHash } from 'node:crypto';
import { normalizeDoi } from './normalize';
import { SourceError, type DoiResolver, type SearchOutcome, type SearchRequest, type SearchSource, type SourceRecord } from './types';

export interface ToolCache {
  get(adapter: string, hash: string): Promise<{ response: unknown; fetchedAt: number; ttlSeconds: number } | null>;
  put(adapter: string, hash: string, response: unknown, ttlSeconds: number): Promise<void>;
}

export class MemoryToolCache implements ToolCache {
  private m = new Map<string, { response: unknown; fetchedAt: number; ttlSeconds: number }>();
  constructor(private now: () => number = Date.now) {}
  async get(a: string, h: string) { return this.m.get(`${a}:${h}`) ?? null; }
  async put(a: string, h: string, response: unknown, ttlSeconds: number) { this.m.set(`${a}:${h}`, { response, fetchedAt: this.now(), ttlSeconds }); }
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val);

/** Model-independent: the key never includes anything about which model asked. */
export function searchHash(adapter: string, req: SearchRequest): string {
  const n = { q: req.query.trim().toLowerCase().replace(/\s+/g, ' '), limit: req.limit ?? 10, yearFrom: req.yearFrom ?? null };
  return createHash('sha256').update(`${adapter}\nsearch\n${stable(n)}`).digest('hex');
}
export function doiHash(adapter: string, doi: string): string {
  return createHash('sha256').update(`${adapter}\ndoi\n${normalizeDoi(doi) ?? doi.toLowerCase()}`).digest('hex');
}

export type CacheMode = 'shared' | 'replay' | 'live';
/** shared: use cache, fill on miss. replay: cache ONLY, a miss is an error (strict model comparison). live: bypass reads, still write. */
export interface CacheOpts { ttlSeconds: number; mode?: CacheMode; now?: () => number }

const fresh = (e: { fetchedAt: number; ttlSeconds: number }, now: number) => now - e.fetchedAt < e.ttlSeconds * 1000;

export class CachedSearchSource implements SearchSource {
  readonly name: string;
  constructor(private inner: SearchSource, private cache: ToolCache, private o: CacheOpts) { this.name = inner.name; }
  async search(req: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome> {
    const mode = this.o.mode ?? 'shared'; const now = (this.o.now ?? Date.now)();
    const key = searchHash(this.name, req);
    if (mode !== 'live') {
      const hit = await this.cache.get(this.name, key);
      if (hit && (mode === 'replay' || fresh(hit, now))) return { records: hit.response as SourceRecord[], cacheHit: true, estimatedCostUsd: 0 };
      if (mode === 'replay') throw new SourceError('cache_miss', `no cached result for "${req.query}" on ${this.name}`);
    }
    const out = await this.inner.search(req, signal);
    await this.cache.put(this.name, key, out.records, this.o.ttlSeconds);
    return out;
  }
}

export class CachedDoiResolver implements DoiResolver {
  readonly name: string;
  constructor(private inner: DoiResolver, private cache: ToolCache, private o: CacheOpts) { this.name = inner.name; }
  async lookupDoi(doi: string, signal?: AbortSignal): Promise<SourceRecord | null> {
    const mode = this.o.mode ?? 'shared'; const now = (this.o.now ?? Date.now)();
    const key = doiHash(this.name, doi);
    if (mode !== 'live') {
      const hit = await this.cache.get(this.name, key);
      if (hit && (mode === 'replay' || fresh(hit, now))) return hit.response as SourceRecord | null;
      if (mode === 'replay') throw new SourceError('cache_miss', `no cached DOI lookup for ${doi}`);
    }
    const rec = await this.inner.lookupDoi(doi, signal);
    await this.cache.put(this.name, key, rec, this.o.ttlSeconds);
    return rec;
  }
}

/** Hard cap on live (non-cached) calls per investigation: protects free-tier allowances while prices are unverified. */
export class CallLimitedSearchSource implements SearchSource {
  readonly name: string; calls = 0;
  constructor(private inner: SearchSource, private maxCalls: number) { this.name = inner.name; }
  async search(req: SearchRequest, signal?: AbortSignal) {
    if (this.calls >= this.maxCalls) throw new SourceError('call_limit', `${this.name}: limit of ${this.maxCalls} live calls reached`);
    this.calls++;
    return this.inner.search(req, signal);
  }
}

export class RateLimiter {
  private next = 0;
  constructor(private minIntervalMs: number, private now: () => number = Date.now, private sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  async wait() {
    const t = this.now(); const at = Math.max(t, this.next);
    this.next = at + this.minIntervalMs;
    if (at > t) await this.sleep(at - t);
  }
}
