// Composition root: the ONLY file outside src/providers/<adapter>/ allowed to name an adapter or its credentials.
import type { PriceBook } from '../pricing';
import type { BaseOptions } from './base';
import { GeminiAdapter } from './gemini/adapter';
import type { ModelProvider } from './types';

interface ProviderInfo { label: string; secretName: string; make(pb: PriceBook, apiKey: string, opts?: BaseOptions): ModelProvider }

export const providers: Record<string, ProviderInfo> = {
  gemini: { label: 'Gemini', secretName: 'GEMINI_API_KEY', make: (pb, apiKey, opts) => new GeminiAdapter(pb, { apiKey, ...opts }) },
};
export const knownProviderKeys = () => Object.keys(providers);

export function createProvider(key: string, priceBook: PriceBook, env: Record<string, string | undefined>, opts?: BaseOptions): ModelProvider {
  const p = providers[key]; if (!p) throw new Error(`unknown provider "${key}"`);
  const apiKey = env[p.secretName]; if (!apiKey) throw new Error(`${p.secretName} is not configured on the worker`);
  return p.make(priceBook, apiKey, opts);
}
/** A provider with a deliberately invalid credential, for the conformance check of error mapping. */
export const createBadCredentialProvider = (key: string, priceBook: PriceBook): ModelProvider => createProvider(key, priceBook, { [providers[key]!.secretName]: 'invalid-credential-for-conformance-check' });

/** Which provider credentials are present (names only, never values), for the setup page. */
export const providerKeyStatus = (env: Record<string, string | undefined>): Record<string, boolean> =>
  Object.fromEntries(Object.values(providers).map(p => [`${p.label} API key`, !!env[p.secretName]]));
