/** Normalisers match the unique indexes in the database (doi lower-cased, url_normalized, title_normalized). */
export function normalizeDoi(input: string): string | null {
  let d = input.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  try { d = decodeURIComponent(d); } catch { /* keep as is */ }
  d = d.trim().toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : null;
}

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$)/i;

export function normalizeUrl(input: string): string | null {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : 1));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

export function normalizeTitle(t: string): string {
  return t.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
