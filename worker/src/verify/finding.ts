import type { RetrievedSet } from '../sources/retrieved-set';
import { verifyQuote, type QuoteResult } from './quote';
import type { CheckResult, CheckStatus } from './types';

export type FindingStatus = 'verified' | 'partial' | 'unverified';

/** Combines DOI and URL checks for one source. An authoritative DOI match dominates; a URL pass alone also verifies. */
export function combineSourceChecks(checks: { doi?: CheckResult; url?: CheckResult }): CheckStatus {
  const { doi, url } = checks;
  if (doi?.status === 'verified') return 'verified';
  if (doi?.status === 'failed') return 'failed';
  if (url?.status === 'verified') return 'verified';
  if (url?.status === 'failed' && !doi) return 'failed';
  return 'unverified';
}

export interface FindingVerificationInput {
  sourceRefs: string[];
  quotes?: Array<{ ref: string; quote: string }>;
  /** per-source verification status keyed by handle, produced by the DOI/URL checks */
  sourceStatus: Record<string, CheckStatus>;
}
export interface FindingVerification {
  status: FindingStatus;
  validRefs: string[]; rejectedRefs: string[];
  quoteResults: Array<{ ref: string; quote: string; result: QuoteResult }>;
  reasons: string[];
}

/** Display status rules. Anything not positively verified is shown as such; nothing is ever silently upgraded. */
export function verifyFinding(input: FindingVerificationInput, set: RetrievedSet): FindingVerification {
  const { valid, rejected } = set.checkRefs(input.sourceRefs);
  const reasons: string[] = [];
  if (rejected.length) reasons.push(`rejected unretrieved references: ${rejected.join(', ')}`);

  const quoteResults = (input.quotes ?? []).map(q => {
    const rec = set.resolve(q.ref);
    const result = !rec || !valid.includes(q.ref) ? { verified: false, reason: 'no_text' as const } : verifyQuote(q.quote, rec.abstract);
    return { ref: q.ref, quote: q.quote, result };
  });
  const badQuotes = quoteResults.filter(q => !q.result.verified);
  if (badQuotes.length) reasons.push(`${badQuotes.length} quote(s) not verified against retrieved text`);

  if (valid.length === 0) return { status: 'unverified', validRefs: valid, rejectedRefs: rejected, quoteResults, reasons: [...reasons, 'no valid sources'] };

  const statuses = valid.map(h => input.sourceStatus[h] ?? 'unverified');
  const allVerified = statuses.every(s => s === 'verified'); const anyVerified = statuses.some(s => s === 'verified');
  if (statuses.some(s => s === 'failed')) reasons.push('a cited source failed verification');
  if (!allVerified && !statuses.some(s => s === 'failed')) reasons.push('a cited source is not yet verified');

  let status: FindingStatus = allVerified ? 'verified' : anyVerified ? 'partial' : 'unverified';
  if ((rejected.length || badQuotes.length || statuses.includes('failed')) && status === 'verified') status = 'partial';
  return { status, validRefs: valid, rejectedRefs: rejected, quoteResults, reasons };
}
