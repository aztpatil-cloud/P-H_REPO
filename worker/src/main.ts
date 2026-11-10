import { createServer } from 'node:http';
import { createApi } from './api/server';
import { createSupabaseVerifier } from './auth';
import { bootstrapDatabase } from './bootstrap';
import { createPgDb } from './db/pg';
import { approvePlan, runResearch, runStage1, type EngineDeps } from './pipeline/engine';
import { PgStore } from './pipeline/store';
import { PriceBook } from './pricing';
import { createBadCredentialProvider, createProvider, knownProviderKeys, providerKeyStatus } from './providers/index';
import { CachedDoiResolver, CachedSearchSource, CallLimitedSearchSource } from './sources/cache';
import { CrossrefResolver } from './sources/crossref';
import { OpenAlexAdapter } from './sources/openalex';
import { PubMedAdapter } from './sources/pubmed';
import { createGuardedFetch } from './verify/guarded-fetch';
import { runJobLoop } from './worker-loop';
import migration0001 from '../../supabase/migrations/0001_core.sql';
import seedSql from '../../supabase/seed.sql';

const env = process.env; const missing = ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'].filter(k => !env[k]);
const PORT = Number(env.PORT ?? 8080);

async function main() {
  if (missing.length) {                                                         // stay up so the host's health check works and the problem is visible
    console.error(`Missing required settings: ${missing.join(', ')}`);
    createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 503, { 'content-type': 'text/plain' }); res.end(req.url === '/health' ? 'ok' : `Setup incomplete. Missing: ${missing.join(', ')}`); }).listen(PORT);
    return;
  }
  const db = createPgDb(env.DATABASE_URL!); const store = new PgStore(db);
  await bootstrapDatabase(db, { migrations: [{ name: '0001_core.sql', sql: migration0001 }], seedSql });
  const providerFor = (key: string) => createProvider(key, new PriceBook([]), env);      // prices come from the database via the metering wrapper
  let enabled: Record<string, boolean> = { openalex: true, pubmed: true };
  const cache = store.toolCache(); const doiResolver = new CachedDoiResolver(new CrossrefResolver({ mailto: env.CONTACT_EMAIL }), cache, { ttlSeconds: 30 * 86400 });
  const engine: EngineDeps = {
    store, providerFor, doiResolver, urlDeps: { fetch: createGuardedFetch() },
    sourcesFor: () => {
      const searchers: Record<string, any> = {}; const descriptions: Record<string, string> = {};
      if (enabled.openalex) { searchers.openalex = new CachedSearchSource(new CallLimitedSearchSource(new OpenAlexAdapter({ apiKey: env.OPENALEX_API_KEY, mailto: env.CONTACT_EMAIL }), 150), cache, { ttlSeconds: 7 * 86400 }); descriptions.openalex = 'scholarly works across all disciplines (papers, reviews, preprints): titles, abstracts, DOIs'; }
      if (enabled.pubmed) { searchers.pubmed = new CachedSearchSource(new CallLimitedSearchSource(new PubMedAdapter({ apiKey: env.NCBI_API_KEY, email: env.CONTACT_EMAIL }), 150), cache, { ttlSeconds: 7 * 86400 }); descriptions.pubmed = 'biomedical and life-science literature: titles and abstracts'; }
      return { searchers, descriptions };
    },
  };
  const api = createApi({ db, store, engine, verifyToken: createSupabaseVerifier(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!), founderEmail: env.FOUNDER_EMAIL,
    keys: { 'Database connection': true, 'Supabase URL': !!env.SUPABASE_URL, 'Supabase anon key': !!env.SUPABASE_ANON_KEY, ...providerKeyStatus(env), 'OpenAlex API key': !!env.OPENALEX_API_KEY, 'Contact email': !!env.CONTACT_EMAIL, 'Founder email': !!env.FOUNDER_EMAIL, 'NCBI key (optional)': !!env.NCBI_API_KEY },
    publicConfig: { supabaseUrl: env.SUPABASE_URL!, anonKey: env.SUPABASE_ANON_KEY! }, knownProviders: knownProviderKeys(), providerFor,
    badCredentialProviderFor: key => createBadCredentialProvider(key, new PriceBook([])) });
  const server = createServer((req, res) => { void api(req, res); }).listen(PORT, () => console.log(`listening on ${PORT}`));
  const ctrl = new AbortController(); for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { ctrl.abort(); server.close(); });
  await runJobLoop(db, {
    stage1: async p => { enabled = (await store.settings()).toolsEnabled; await runStage1(engine, p.investigationId); },
    research: async p => { enabled = (await store.settings()).toolsEnabled; await runResearch(engine, p.investigationId); },
  }, { workerId: `w-${process.pid}`, signal: ctrl.signal });
}
main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
