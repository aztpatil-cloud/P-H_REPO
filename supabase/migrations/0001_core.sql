-- P&H R&D Agent: Phase 1a core schema.
-- Conventions: all tables have RLS on. Clients only READ (plus a few narrow writes);
-- every other mutation goes through the worker, which uses the service role.

-- ───────────────────────── access ─────────────────────────
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'member' check (role in ('founder','architect','member')),
  created_at timestamptz not null default now()
);

create function public.current_role_name() returns text
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() $$;

create function public.is_member() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.profiles where id = auth.uid()) $$;

create function public.is_prompt_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce(public.current_role_name() in ('founder','architect'), false) $$;

-- ───────────────────────── settings & prices ─────────────────────────
-- Single row. Caps are NULL until the founder sets them; stage 2 refuses to run while NULL.
create table public.settings (
  id int primary key default 1 check (id = 1),
  monthly_budget_inr numeric(12,2) check (monthly_budget_inr is null or monthly_budget_inr > 0),
  investigation_cap_inr numeric(12,2) check (investigation_cap_inr is null or investigation_cap_inr > 0),
  fx_rate_inr_per_usd numeric(8,3) check (fx_rate_inr_per_usd is null or fx_rate_inr_per_usd > 0),
  wrapup_reserve_pct numeric(5,2) not null default 10 check (wrapup_reserve_pct between 0 and 50),
  warn_at_pct numeric(5,2) not null default 80 check (warn_at_pct between 1 and 99),
  test_run_cap_inr numeric(12,2) check (test_run_cap_inr is null or test_run_cap_inr > 0), -- NULL blocks test runs
  tools_enabled jsonb not null default '{"openalex":true,"pubmed":true,"crossref":true,"semanticscholar":false}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- ───────────────────────── model registry & routing ─────────────────────────
-- Provider-neutral. provider_model (the vendor's own model string) is read only by the registry and
-- that provider's adapter. Workflows ask for capabilities, never for model names.
create table public.model_registry (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_model text not null,
  display_name text not null,
  status text not null default 'candidate' check (status in ('candidate','active','deprecated','disabled')),
  context_tokens int not null check (context_tokens > 0),
  max_output_tokens int not null check (max_output_tokens > 0),
  supports_structured_output boolean not null default false,
  supports_tool_calling boolean not null default false,
  supports_embeddings boolean not null default false,
  reasoning_billed_as_output boolean not null default true,
  embedding_dimension int check (embedding_dimension is null or embedding_dimension > 0),
  trains_on_inputs text not null default 'unknown' check (trains_on_inputs in ('yes','no','unknown')),
  retention_note text,
  data_region text,
  data_policy_source_url text,
  data_policy_verified_at timestamptz,
  data_policy_verified_by uuid references public.profiles(id),
  conformance_version int,
  conformance_passed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, provider_model)
);

-- Prices are data, not code, and carry an effective date (published prices change on known dates).
-- verified_at stays NULL until a human re-checks the price against the provider's page; the worker
-- refuses to call a model whose current price is unverified.
create table public.model_prices (
  id uuid primary key default gen_random_uuid(),
  model_registry_id uuid not null references public.model_registry(id) on delete cascade,
  input_usd_per_m numeric(10,4) not null check (input_usd_per_m >= 0),
  output_usd_per_m numeric(10,4) not null check (output_usd_per_m >= 0),
  cached_input_usd_per_m numeric(10,4),
  effective_from date not null,
  source_note text,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id),
  unique (model_registry_id, effective_from)
);

-- A model may handle confidential material only if: provider does not train on inputs, that was verified
-- by a human within the last 90 days, adapter conformance has passed, and the model is active.
create function public.model_confidential_ok(p_model uuid) returns boolean
language sql stable as $$
  select coalesce((select trains_on_inputs = 'no'
                     and data_policy_verified_at is not null
                     and data_policy_verified_at > now() - interval '90 days'
                     and conformance_passed_at is not null
                     and status = 'active'
                   from public.model_registry where id = p_model), false)
$$;

create table public.model_routes (
  task text primary key check (task in
    ('stage1_plan','stage2_research','extraction','report','verification_helper','embeddings')),
  primary_model_id uuid not null references public.model_registry(id),
  fallback_model_id uuid references public.model_registry(id),
  handles_confidential boolean not null default true,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  check (fallback_model_id is null or fallback_model_id <> primary_model_id)
);

-- Each investigation pins a snapshot, like it pins a prompt set.
create table public.routing_snapshots (
  id uuid primary key default gen_random_uuid(),
  routes jsonb not null,            -- {"stage2_research":{"primary":"<uuid>","fallback":null}, ...}
  created_at timestamptz not null default now()
);

-- ───────────────────────── prompt files ─────────────────────────
create table public.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('stage1_plan','stage2_research','report_template','evidence_labels')),
  version int not null,
  name text not null,
  schema_version int not null default 1,
  content text not null,
  parsed jsonb,                                    -- filled by the worker's validator
  status text not null default 'draft' check (status in ('draft','active','archived')),
  validation_errors jsonb,                         -- null = not yet validated; [] = valid
  notes text,
  author uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  activated_by uuid references public.profiles(id),
  unique (kind, version)
);
-- Exactly one active version per kind.
create unique index prompt_versions_one_active on public.prompt_versions(kind) where status = 'active';

create function public.prompt_version_assign() returns trigger language plpgsql as $$
begin
  if new.version is null or new.version = 0 then
    select coalesce(max(version),0)+1 into new.version from public.prompt_versions where kind = new.kind;
  end if;
  return new;
end $$;
create trigger prompt_versions_assign before insert on public.prompt_versions
  for each row execute function public.prompt_version_assign();

-- Versions are immutable: only status/validation fields/activation stamps may change.
create function public.prompt_version_immutable() returns trigger language plpgsql as $$
begin
  if new.kind is distinct from old.kind or new.version is distinct from old.version
     or new.content is distinct from old.content or new.name is distinct from old.name
     or new.schema_version is distinct from old.schema_version then
    raise exception 'prompt versions are immutable; save a new version instead';
  end if;
  return new;
end $$;
create trigger prompt_versions_immutable before update on public.prompt_versions
  for each row execute function public.prompt_version_immutable();

-- Materialised label definitions (one set per evidence_labels prompt version).
create table public.evidence_labels (
  prompt_version_id uuid not null references public.prompt_versions(id) on delete cascade,
  key text not null,
  name text not null,
  definition text not null,
  criteria text,
  deprecated boolean not null default false,
  primary key (prompt_version_id, key)
);

-- Snapshot of the four versions an investigation is pinned to.
create table public.prompt_sets (
  id uuid primary key default gen_random_uuid(),
  stage1_id uuid not null references public.prompt_versions(id),
  stage2_id uuid not null references public.prompt_versions(id),
  template_id uuid not null references public.prompt_versions(id),
  labels_id uuid not null references public.prompt_versions(id),
  created_at timestamptz not null default now()
);

-- Activation: validated, role-checked, audited, atomic. Archives the previous active version.
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  detail jsonb
);

create function public.activate_prompt_version(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v public.prompt_versions;
begin
  if not public.is_prompt_admin() then raise exception 'not allowed'; end if;
  select * into v from public.prompt_versions where id = p_id for update;
  if not found then raise exception 'unknown prompt version'; end if;
  if v.validation_errors is null or jsonb_array_length(v.validation_errors) > 0 then
    raise exception 'version is not validated or has errors';
  end if;
  update public.prompt_versions set status = 'archived'
    where kind = v.kind and status = 'active' and id <> p_id;
  update public.prompt_versions set status = 'active', activated_at = now(), activated_by = auth.uid()
    where id = p_id;
  insert into public.audit_log(actor, action, detail)
    values (auth.uid(), 'prompt_activated', jsonb_build_object('id', p_id, 'kind', v.kind, 'version', v.version));
end $$;

-- ───────────────────────── investigations ─────────────────────────
create table public.investigations (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  problem text not null,
  industries_include text[] not null default '{}',
  industries_exclude text[] not null default '{}',
  status text not null default 'planning' check (status in
    ('planning','awaiting_approval','researching','reporting','complete','stopped_budget','stopped_user','failed')),
  prompt_set_id uuid references public.prompt_sets(id),
  routing_snapshot_id uuid references public.routing_snapshots(id),
  confidential boolean not null default true,
  is_test boolean not null default false,
  stop_requested boolean not null default false,
  cap_inr numeric(12,2) not null check (cap_inr > 0),   -- effective cap for this investigation
  coverage_status text not null default 'pending'
    check (coverage_status in ('pending','complete','incomplete_budget','incomplete_stopped','incomplete_error')),
  coverage_note text,
  coverage_profile jsonb,                 -- sources searched, content basis counts, limited-coverage flag and reasons
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.run_stages (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  stage text not null check (stage in ('plan','research','report')),
  status text not null default 'queued' check (status in ('queued','running','awaiting_approval','approved','done','stopped','failed')),
  plan_json jsonb,
  user_edits jsonb,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  progress jsonb not null default '{}'::jsonb,   -- resumable work log: completed sub-questions, synthesis, report sections
  created_at timestamptz not null default now()
);
create index on public.run_stages(investigation_id, stage);

-- ───────────────────────── sources ─────────────────────────
create table public.external_sources (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in
    ('peer_reviewed_paper','review_article','preprint','patent','technical_report','standard_regulatory','company_web','trade_press','internal_doc','other')),
  doi text,
  url text,
  url_normalized text,
  title text not null,
  title_normalized text,
  authors text[],
  published_on date,
  published_precision text check (published_precision in ('year','month','day')),   -- published_on holds the first day of the stated period
  abstract text,
  oa_url text,
  content_basis text not null default 'metadata_only' check (content_basis in ('metadata_only','abstract','full_text')),  -- what the system actually saw
  retrieved_via text not null,                -- adapter name; the ONLY way a source can enter
  retrieved_at timestamptz not null default now(),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','verified','failed')),
  verification_detail jsonb,
  verified_at timestamptz
);
create unique index external_sources_doi_uq on public.external_sources (lower(doi)) where doi is not null;
create unique index external_sources_url_uq on public.external_sources (url_normalized) where url_normalized is not null;

-- Which sources were retrieved for which investigation, under which model-facing handle (S1, S2…).
create table public.investigation_sources (
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  source_id uuid not null references public.external_sources(id),
  handle text not null,
  seq int not null,
  sub_question_id text,
  origin text not null default 'plan' check (origin in ('plan','followup')),
  primary key (investigation_id, source_id),
  unique (investigation_id, handle)
);

-- ───────────────────────── findings ─────────────────────────
create table public.findings (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  sub_question_id text,
  claim text not null,
  evidence_label text not null,
  label_set_id uuid not null,
  label_rationale text,
  mechanism text,
  limitations text,
  source_type text not null check (source_type in
    ('peer_reviewed_paper','review_article','preprint','patent','technical_report','standard_regulatory','company_web','trade_press','internal_doc','other')),
  industry_of_origin text,
  verification_status text not null default 'unverified' check (verification_status in ('unverified','partial','verified')),
  label_check text not null default 'not_checked' check (label_check in ('passed','failed','not_checked')),  -- structured label rules
  label_check_note text,
  supported_label text,                                   -- strongest label the cited sources support, when the label file defines strengths
  extras jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (label_set_id, evidence_label) references public.evidence_labels(prompt_version_id, key)
);
create index on public.findings(investigation_id);

create table public.finding_sources (
  finding_id uuid not null references public.findings(id) on delete cascade,
  source_id uuid not null references public.external_sources(id),
  chunk_id uuid,                                    -- reserved for Phase 1b (Drive library)
  quote text,
  reports_test_data boolean,                        -- model-asserted: does this source report test data for the claim
  names_real_use boolean,                           -- model-asserted: does this source name a real product, process or user
  quote_verified boolean,                           -- null = no quote given
  primary key (finding_id, source_id)
);

-- Commercial fields: a value MUST carry a source, otherwise it is explicitly "not estimated".
create table public.finding_commercial (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id) on delete cascade,
  field text not null,
  value text,
  unit text,
  source_id uuid references public.external_sources(id),
  status text not null check (status in ('sourced','not_estimated')),
  unique (finding_id, field),
  check (
    (status = 'sourced' and value is not null and source_id is not null)
    or (status = 'not_estimated' and value is null and source_id is null)
  )
);

-- Approaches, experiment proposals and null results: the agent's instructions require rejected approaches,
-- "nothing reliable found" outcomes, per-approach fit assessments and ranked experiments to be kept, not just findings.
create table public.approaches (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  sub_question_id text,
  name text not null,
  industry_of_origin text,
  status text not null check (status in ('kept','rejected','inconclusive')),
  summary text,
  reason text,
  biggest_weakness text,
  ph_fit jsonb not null default '{}'::jsonb,
  finding_ids uuid[] not null default '{}',
  rank int,
  confidence text check (confidence in ('low','medium','high')),
  rank_rationale text,
  uncertainty_note text,
  next_step text,
  created_at timestamptz not null default now()
);
create index on public.approaches(investigation_id);

create table public.approach_commercial (
  id uuid primary key default gen_random_uuid(),
  approach_id uuid not null references public.approaches(id) on delete cascade,
  field text not null,
  value text,
  unit text,
  source_id uuid references public.external_sources(id),
  status text not null check (status in ('sourced','not_estimated')),
  unique (approach_id, field),
  check (
    (status = 'sourced' and value is not null and source_id is not null)
    or (status = 'not_estimated' and value is null and source_id is null)
  )
);

create table public.experiment_proposals (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  approach_id uuid references public.approaches(id) on delete set null,
  approach_name text not null,
  hypothesis text not null,
  variables text[] not null default '{}',
  control text,
  measurement_method text,
  pass_fail_criterion text,
  stop_condition text,
  rank int,
  rank_rationale text,
  created_at timestamptz not null default now()
);
create index on public.experiment_proposals(investigation_id);

create table public.null_results (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  sub_question_id text,
  note text not null,
  created_at timestamptz not null default now()
);

-- ───────────────────────── reports ─────────────────────────
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  template_id uuid not null references public.prompt_versions(id),
  partial boolean not null default false,
  banner text,
  created_at timestamptz not null default now()
);
create table public.report_sections (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  section_key text not null,
  position int not null,
  title text not null,
  content text not null,
  finding_ids uuid[] not null default '{}',
  unique (report_id, section_key)
);

-- ───────────────────────── operations ─────────────────────────
create table public.search_log (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  run_stage_id uuid references public.run_stages(id) on delete set null,
  origin text not null default 'plan' check (origin in ('plan','followup')),
  tool text not null,
  query text not null,
  industry text,
  status text not null check (status in ('planned','results','empty','error','rate_limited','cache_hit','skipped_budget','skipped_user')),
  result_count int,
  error text,
  cost_inr numeric(12,4) not null default 0,
  created_at timestamptz not null default now()
);
create index on public.search_log(investigation_id);

create table public.model_calls (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid references public.investigations(id) on delete set null,
  run_stage_id uuid references public.run_stages(id) on delete set null,
  test_run_id uuid,                                   -- FK added with the comparison tables
  task text not null,
  model_registry_id uuid not null references public.model_registry(id),
  finish_reason text,
  error_kind text,
  schema_valid boolean,
  schema_failures int not null default 0,
  retries int not null default 0,
  latency_ms int,
  input_tokens int,
  output_tokens int,                                  -- billed output, INCLUDING reasoning tokens
  cached_input_tokens int,
  reasoning_tokens int,
  fallback_used boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.model_calls(investigation_id);

create table public.cost_ledger (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid references public.investigations(id) on delete set null,
  run_stage_id uuid references public.run_stages(id) on delete set null,
  call_type text not null check (call_type in ('llm','tool')),
  provider text not null,
  model_or_tool text not null,
  input_tokens int,
  output_tokens int,
  cached_input_tokens int,
  reasoning_tokens int,
  task text,
  model_registry_id uuid references public.model_registry(id),
  model_call_id uuid references public.model_calls(id),
  price_input_usd_per_m numeric(10,4),               -- price snapshot used for this call
  price_output_usd_per_m numeric(10,4),
  price_cached_usd_per_m numeric(10,4),
  fx_rate numeric(8,3),
  is_test boolean not null default false,
  cost_usd numeric(14,6) not null default 0,
  cost_inr numeric(14,4) not null default 0,
  is_estimated boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.cost_ledger(investigation_id);
create index on public.cost_ledger(created_at);

create function public.investigation_spend_inr(p_id uuid) returns numeric
language sql stable as $$ select coalesce(sum(cost_inr),0) from public.cost_ledger where investigation_id = p_id $$;

create function public.month_spend_inr(p_at timestamptz default now()) returns numeric
language sql stable as $$
  select coalesce(sum(cost_inr),0) from public.cost_ledger
  where created_at >= date_trunc('month', p_at at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
    and created_at <  (date_trunc('month', p_at at time zone 'Asia/Kolkata') + interval '1 month') at time zone 'Asia/Kolkata'
$$;

create function public.month_test_spend_inr(p_at timestamptz default now()) returns numeric
language sql stable as $$
  select coalesce(sum(cost_inr),0) from public.cost_ledger
  where is_test
    and created_at >= date_trunc('month', p_at at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
    and created_at <  (date_trunc('month', p_at at time zone 'Asia/Kolkata') + interval '1 month') at time zone 'Asia/Kolkata'
$$;

create table public.tool_cache (
  adapter text not null,
  request_hash text not null,
  response jsonb not null,
  fetched_at timestamptz not null default now(),
  ttl_seconds int not null,
  primary key (adapter, request_hash)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now()
);
create index jobs_claim on public.jobs(status, run_after);

create function public.claim_job(p_worker text) returns public.jobs
language plpgsql as $$
declare j public.jobs;
begin
  select * into j from public.jobs
   where (status = 'queued' and run_after <= now())
      or (status = 'running' and locked_at < now() - interval '5 minutes')  -- reclaim crashed workers
   order by run_after for update skip locked limit 1;
  if not found then return null; end if;
  update public.jobs set status='running', attempts=attempts+1, locked_at=now(), locked_by=p_worker
   where id = j.id returning * into j;
  return j;
end $$;

-- Human-only verification gates (founder). These are the ONLY way verified_at columns get set.
create function public.verify_model_data_policy(
  p_model uuid, p_trains_on_inputs text, p_source_url text, p_retention_note text, p_region text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() <> 'founder' then raise exception 'founder only'; end if;
  if p_trains_on_inputs not in ('yes','no') then raise exception 'state yes or no explicitly'; end if;
  if coalesce(trim(p_source_url),'') = '' or coalesce(trim(p_retention_note),'') = '' then
    raise exception 'source url and retention note are required';
  end if;
  update public.model_registry set trains_on_inputs = p_trains_on_inputs, data_policy_source_url = p_source_url,
    retention_note = p_retention_note, data_region = p_region,
    data_policy_verified_at = now(), data_policy_verified_by = auth.uid() where id = p_model;
  if not found then raise exception 'unknown model'; end if;
  insert into public.audit_log(actor, action, detail) values (auth.uid(), 'data_policy_verified',
    jsonb_build_object('model', p_model, 'trains_on_inputs', p_trains_on_inputs, 'source', p_source_url));
end $$;

create function public.verify_model_price(p_price uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() <> 'founder' then raise exception 'founder only'; end if;
  update public.model_prices set verified_at = now(), verified_by = auth.uid() where id = p_price;
  if not found then raise exception 'unknown price'; end if;
  insert into public.audit_log(actor, action, detail) values (auth.uid(), 'price_verified', jsonb_build_object('price', p_price));
end $$;

-- ───────────────────────── row-level security ─────────────────────────
do $$
declare t text;
begin
  foreach t in array array['profiles','settings','model_prices','prompt_versions','evidence_labels','prompt_sets',
    'audit_log','model_registry','model_routes','routing_snapshots','model_calls','investigations','run_stages','external_sources','findings','finding_sources','finding_commercial',
    'approaches','approach_commercial','experiment_proposals','null_results','investigation_sources','reports','report_sections','search_log','cost_ledger','tool_cache','jobs'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Members can read the shared workspace. Worker (service role) bypasses RLS for all writes.
do $$
declare t text;
begin
  foreach t in array array['settings','model_registry','model_prices','model_routes','routing_snapshots','model_calls','prompt_versions','evidence_labels','prompt_sets','investigations',
    'run_stages','external_sources','findings','finding_sources','finding_commercial','approaches','approach_commercial','experiment_proposals','null_results','investigation_sources','reports','report_sections',
    'search_log','cost_ledger'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member())', t||'_read', t);
  end loop;
end $$;

create policy profiles_read_self on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_role_name() = 'founder');
create policy audit_read_admin on public.audit_log for select to authenticated using (public.is_prompt_admin());
-- tool_cache and jobs: no client policies at all (service role only).

-- Prompt admins may save drafts directly (immutable once saved). Activation goes through the RPC.
create policy prompt_versions_insert_draft on public.prompt_versions for insert to authenticated
  with check (public.is_prompt_admin() and status = 'draft' and author = auth.uid());

revoke all on public.tool_cache, public.jobs from anon, authenticated;
revoke execute on function public.claim_job(text) from anon, authenticated;
