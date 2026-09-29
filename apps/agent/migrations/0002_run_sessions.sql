create table run_sessions (
  run_id text primary key references patch_runs (id),
  session_id text not null,
  transcript text not null,
  totals jsonb not null,
  updated_at timestamptz not null default now()
);
