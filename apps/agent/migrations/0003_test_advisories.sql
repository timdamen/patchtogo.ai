create table test_advisories (
  ghsa_id text primary key check (ghsa_id like 'GHSA-ptg0-%'),
  advisory jsonb not null,
  updated_at timestamptz not null default now()
);
