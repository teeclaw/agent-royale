-- Phase 2 schema patch: write-path integrity tables

create table if not exists casino_requests (
  id bigserial primary key,
  request_key text not null unique,
  action text not null,
  agent text,
  status text not null default 'done',
  response jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_casino_requests_action_created on casino_requests(action, created_at desc);

create table if not exists casino_lotto_draws (
  id bigserial primary key,
  draw_id bigint not null unique,
  commitment text not null,
  draw_time timestamptz not null,
  drawn boolean not null default false,
  result_number integer,
  created_at timestamptz not null default now()
);

create table if not exists casino_lotto_tickets (
  id bigserial primary key,
  draw_id bigint not null,
  agent text not null,
  picked_number integer not null,
  ticket_count integer not null default 1,
  cost numeric not null default 0,
  created_at timestamptz not null default now(),
  unique(draw_id, agent, picked_number)
);

create index if not exists idx_lotto_tickets_draw_agent on casino_lotto_tickets(draw_id, agent);

-- Optional hardening columns on existing table
alter table casino_channels add column if not exists updated_at timestamptz not null default now();
