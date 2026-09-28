create table advisories (
  ghsa_id text primary key,
  cve_id text,
  severity text not null,
  summary text not null,
  description text not null,
  first_seen_at timestamptz not null,
  updated_at timestamptz not null
);

create table patch_runs (
  seq bigint generated always as identity unique,
  id text primary key,
  ghsa_id text not null references advisories (ghsa_id),
  package_name text not null,
  advisory jsonb not null,
  state text not null,
  reason text,
  failure jsonb,
  details jsonb not null default '{}',
  version integer not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index patch_runs_ghsa_id on patch_runs (ghsa_id);
create index patch_runs_state on patch_runs (state);

create table run_events (
  run_id text not null references patch_runs (id),
  version integer not null,
  state text not null,
  reason text,
  failure jsonb,
  at timestamptz not null,
  primary key (run_id, version)
);

create table run_costs (
  id bigint generated always as identity primary key,
  run_id text not null references patch_runs (id),
  step text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cost_usd double precision,
  sandbox_seconds double precision not null,
  at timestamptz not null
);

create index run_costs_run_id on run_costs (run_id);

create view run_cost_totals as
select
  run_id,
  sum(input_tokens)::bigint as input_tokens,
  sum(output_tokens)::bigint as output_tokens,
  sum(cost_usd) as cost_usd,
  sum(sandbox_seconds) as sandbox_seconds
from run_costs
group by run_id;

create table run_token_revocations (
  token_id text primary key,
  expires_at timestamptz not null
);

create table poll_cursors (
  name text primary key,
  position timestamptz not null
);
