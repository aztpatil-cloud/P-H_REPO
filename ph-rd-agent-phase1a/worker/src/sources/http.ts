import { SourceError } from './types';

export interface HttpOpts {
  fetch: typeof fetch; headers?: Record<string, string>; timeoutMs?: number; maxRetries?: number;
  sleep?: (ms: number) => Promise<void>; signal?: AbortSignal; allow404?: boolean;
}

/** GET with timeout, bounded retries on 429/5xx/network, and typed errors. Returns null on an allowed 404. */
export async function httpGet(url: string, o: HttpOpts, as: 'json' | 'text'): Promise<any> {
  const sleep = o.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
      const onAbort = () => ctrl.abort();
      o.signal?.addEventListener('abort', onAbort);
      let res: Response;
      try { res = await o.fetch(url, { headers: o.headers, signal: ctrl.signal }); }
      catch (e) {
        if (o.signal?.aborted) throw new SourceError('timeout', 'aborted');
        throw new SourceError((e as Error).name === 'AbortError' ? 'timeout' : 'server', `network: ${(e as Error).message}`);
      } finally { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); }

      if (res.status === 404 && o.allow404) return null;
      if (res.status === 429) { const ra = res.headers.get('retry-after'); throw new SourceError('rate_limit', 'rate limited', ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined); }
      if (res.status === 401 || res.status === 403) throw new SourceError('auth', `HTTP ${res.status}`);
      if (res.status === 404) throw new SourceError('not_found', 'HTTP 404');
      if (res.status >= 500) throw new SourceError('server', `HTTP ${res.status}`);
      if (!res.ok) throw new SourceError('bad_response', `HTTP ${res.status}`);
      const body = await res.text();
      if (as === 'text') return body;
      try { return JSON.parse(body); } catch { throw new SourceError('bad_response', 'response was not JSON'); }
    } catch (e) {
      if (!(e instanceof SourceError) || !e.retryable || attempt >= maxRetries) throw e;
      await sleep(e.retryAfterMs ?? Math.min(500 * 2 ** attempt, 8000));
    }
  }
}
