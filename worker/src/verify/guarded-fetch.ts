import { Agent, fetch as undiciFetch } from 'undici';
import { makeGuardedLookup } from './ssrf';

/** Production fetch for URL verification: every connection re-validates the resolved address. */
export function createGuardedFetch(): typeof fetch {
  const dispatcher = new Agent({ connect: { lookup: makeGuardedLookup() as any } });
  return ((url: any, init: any) => undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
}
