import { normalizeDoi } from '../sources/normalize';
import { SourceError, type DoiResolver } from '../sources/types';
import { jaccard } from './similarity';
import type { CheckResult } from './types';

/** DOI check: it must exist in the registry AND its registered title must match what we stored.
 *  A registry outage never marks a source failed: it stays unverified so it can be re-checked. */
export async function verifyDoi(input: { doi: string; storedTitle: string }, resolver: DoiResolver, threshold = 0.7, signal?: AbortSignal): Promise<CheckResult> {
  const doi = normalizeDoi(input.doi);
  if (!doi) return { status: 'failed', reason: 'malformed_doi' };
  let rec;
  try { rec = await resolver.lookupDoi(doi, signal); }
  catch (e) {
    if (e instanceof SourceError) return { status: 'unverified', reason: 'registry_unavailable', detail: { error: e.kind } };
    throw e;
  }
  if (!rec) return { status: 'failed', reason: 'doi_not_found' };
  const sim = jaccard(rec.title, input.storedTitle);
  if (sim < threshold) return { status: 'failed', reason: 'title_mismatch', detail: { similarity: Number(sim.toFixed(2)), registeredTitle: rec.title } };
  return { status: 'verified', reason: 'doi_resolved', detail: { similarity: Number(sim.toFixed(2)) } };
}
