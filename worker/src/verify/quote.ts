/** Word-level comparison: typography (curly quotes, dashes, case, hyphenation artefacts) cannot cause or hide a mismatch. */
const words = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\u00ad]/g, '').match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)?.map(w => w.replace('’', "'")) ?? [];

export const MIN_QUOTE_WORDS = 6;

export interface QuoteResult { verified: boolean; reason: 'ok' | 'not_found' | 'too_short' | 'no_text' }

/** A quote is verified only if it appears, as a word sequence, in text we actually retrieved.
 *  Ellipses ("…" or "...") split a quote into segments that must each appear, in order. */
export function verifyQuote(quote: string, sourceText: string | undefined | null): QuoteResult {
  if (!sourceText || !sourceText.trim()) return { verified: false, reason: 'no_text' };
  const segments = quote.split(/\s*(?:\.\.\.|…|\[\s*\.\.\.\s*\])\s*/).map(words).filter(w => w.length);
  if (segments.reduce((n, s) => n + s.length, 0) < MIN_QUOTE_WORDS) return { verified: false, reason: 'too_short' };
  const hay = words(sourceText); let from = 0;
  for (const seg of segments) {
    let found = -1;
    outer: for (let i = from; i + seg.length <= hay.length; i++) {
      for (let j = 0; j < seg.length; j++) if (hay[i + j] !== seg[j]) continue outer;
      found = i; break;
    }
    if (found < 0) return { verified: false, reason: 'not_found' };
    from = found + seg.length;
  }
  return { verified: true, reason: 'ok' };
}
