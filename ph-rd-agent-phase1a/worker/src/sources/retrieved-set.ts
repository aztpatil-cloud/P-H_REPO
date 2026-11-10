import { normalizeDoi, normalizeTitle, normalizeUrl } from './normalize';
import type { SourceRecord } from './types';

export interface Handle { handle: string; record: SourceRecord }

/** Everything the model may cite in one investigation. The model sees short handles (S1, S2…), never raw
 *  identifiers, and anything else it writes is rejected. Duplicates (same DOI / URL / title) collapse to one handle. */
export class RetrievedSet {
  private byHandle = new Map<string, SourceRecord>();
  private byDoi = new Map<string, string>(); private byUrl = new Map<string, string>(); private byTitle = new Map<string, string>();
  private n = 0;

  add(r: SourceRecord): { handle: string; created: boolean } {
    const doi = r.doi ? normalizeDoi(r.doi) : null; const url = r.url ? normalizeUrl(r.url) : null; const title = normalizeTitle(r.title);
    const existing = (doi && this.byDoi.get(doi)) || (url && this.byUrl.get(url)) || (title.length >= 20 ? this.byTitle.get(title) : undefined);
    if (existing) { this.merge(existing, r); return { handle: existing, created: false }; }
    const handle = `S${++this.n}`;
    this.byHandle.set(handle, { ...r, doi: doi ?? undefined });
    if (doi) this.byDoi.set(doi, handle); if (url) this.byUrl.set(url, handle); if (title.length >= 20) this.byTitle.set(title, handle);
    return { handle, created: true };
  }
  /** Fills gaps (e.g. an abstract) from a duplicate without overwriting what we already have. */
  private merge(handle: string, r: SourceRecord) {
    const cur = this.byHandle.get(handle)!;
    this.byHandle.set(handle, { ...cur, abstract: cur.abstract ?? r.abstract, oaUrl: cur.oaUrl ?? r.oaUrl, doi: cur.doi ?? (r.doi ? normalizeDoi(r.doi) ?? undefined : undefined),
      authors: cur.authors?.length ? cur.authors : r.authors, publishedOn: cur.publishedOn ?? r.publishedOn });
  }
  resolve(handle: string): SourceRecord | undefined { return this.byHandle.get(handle); }
  has(handle: string) { return this.byHandle.has(handle); }
  get size() { return this.byHandle.size; }
  entries(): Handle[] { return [...this.byHandle].map(([handle, record]) => ({ handle, record })); }
  /** Splits what a model cited into resolvable handles and rejected strings (fabricated or malformed). */
  checkRefs(refs: string[]): { valid: string[]; rejected: string[] } {
    const valid: string[] = []; const rejected: string[] = [];
    for (const r of refs) (this.byHandle.has(r) ? (valid.includes(r) ? [] : valid) : rejected).push(r);
    return { valid, rejected };
  }
}
