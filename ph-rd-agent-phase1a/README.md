# P&H R&D Agent: platform (Phase 1a)
- `worker/`: the application (API, research pipeline, operations console). `npm test` runs the test suite; `npm run build` bundles it.
- `supabase/`: `migrations/0001_core.sql` (schema) and `seed.sql` (generated from `prompts/seed/`; regenerate with `npm run gen-seed`).
- `prompts/seed/`: the instruction files and test set supplied by the R&D Intelligence Architect (never edited here).
- `docs/DEPLOYMENT.md`: step-by-step setup for a non-technical founder.
