import { assertPublicUrl, SsrfError, systemResolve, type ResolveHost } from './ssrf';
import { containment } from './similarity';
import type { CheckResult } from './types';

export interface UrlDeps {
  fetch: typeof fetch; resolveHost?: ResolveHost; timeoutMs?: number; maxBytes?: number; maxRedirects?: number;
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); total += value.length;
    if (total >= maxBytes) { await reader.cancel(); break; }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
}

function pageTitle(html: string): string {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return (og ?? t ?? '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

/** Re-fetches a URL server-side (SSRF-safe, size- and time-limited) and compares its title to what we stored.
 *  verified: reachable AND title matches. unverified: reachable but can't confirm (paywall, bot block, PDF, JS page).
 *  failed: gone (404/410), blocked by our safety rules, or unreachable. */
export async function verifyUrl(input: { url: string; expectedTitle: string }, d: UrlDeps, threshold = 0.6): Promise<CheckResult> {
  const resolve = d.resolveHost ?? systemResolve; const maxRedirects = d.maxRedirects ?? 5; const maxBytes = d.maxBytes ?? 1_000_000;
  let current = input.url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u: URL;
    try { u = await assertPublicUrl(current, resolve); }
    catch (e) { return { status: 'failed', reason: 'blocked_by_safety_check', detail: { hop, message: (e as Error).message } }; }
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), d.timeoutMs ?? 10_000);
    let res: Response;
    try { res = await d.fetch(u.toString(), { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'PH-RD-Agent-Verifier/1.0', accept: 'text/html,application/xhtml+xml,*/*;q=0.5' } }); }
    catch (e) { clearTimeout(timer); return e instanceof SsrfError ? { status: 'failed', reason: 'blocked_by_safety_check' } : { status: 'failed', reason: (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable' }; }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location'); if (!loc) return { status: 'failed', reason: 'redirect_without_location' };
      current = new URL(loc, u).toString(); continue;
    }
    if (res.status === 404 || res.status === 410) return { status: 'failed', reason: 'not_found', detail: { status: res.status } };
    if (res.status === 401 || res.status === 403 || res.status === 429) return { status: 'unverified', reason: 'blocked_or_paywalled', detail: { status: res.status } };
    if (res.status >= 400) return { status: 'failed', reason: 'http_error', detail: { status: res.status } };
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!/html|xml/.test(ct)) { await res.body?.cancel(); return { status: 'unverified', reason: 'reachable_not_html', detail: { contentType: ct } }; }
    const html = await readLimited(res, maxBytes);
    const title = pageTitle(html); const sim = containment(title, input.expectedTitle);
    if (title && sim >= threshold) return { status: 'verified', reason: 'title_match', detail: { similarity: Number(sim.toFixed(2)), pageTitle: title } };
    return { status: 'unverified', reason: title ? 'reachable_title_mismatch' : 'reachable_no_title', detail: { pageTitle: title, similarity: Number(sim.toFixed(2)) } };
  }
  return { status: 'failed', reason: 'too_many_redirects' };
}
