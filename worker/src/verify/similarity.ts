const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'with', 'by', 'from', 'at', 'as', 'is', 'are', 'its', 'via']);

export function tokens(s: string): string[] {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t && !STOP.has(t));
}
export function jaccard(a: string, b: string): number {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
/** Share of the SHORTER token set found in the longer: for matching a title inside a longer page title. */
export function containment(a: string, b: string): number {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hit = 0; for (const t of small) if (big.has(t)) hit++;
  return hit / small.size;
}
