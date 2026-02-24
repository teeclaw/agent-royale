-- Agent Royale Vercel/Supabase Phase 1 (read API)

create table if not exists casino_channels (
  id bigserial primary key,
  agent text not null,
  status text not null default 'open',
  agent_deposit numeric not null default 0,
  casino_deposit numeric not null default 0,
  agent_balance numeric not null default 0,
  casino_balance numeric not null default 0,
  nonce bigint not null default 0,
  games_played integer not null default 0,
  opened_at timestamptz not null default now()
);

create index if not exists idx_casino_channels_status_opened on casino_channels(status, opened_at desc);
create index if not exists idx_casino_channels_agent on casino_channels(agent);

create table if not exists casino_rounds (
  id bigserial primary key,
  agent text not null,
  game text not null,
  bet numeric not null default 0,
  payout numeric not null default 0,
  won boolean,
  multiplier numeric,
  reels jsonb,
  choice text,
  result text,
  picked_number integer,
  draw_id bigint,
  ticket_count integer,
  nonce bigint,
  timestamp timestamptz not null default now()
);

create index if not exists idx_casino_rounds_agent_ts on casino_rounds(agent, timestamp desc);
create index if not exists idx_casino_rounds_ts on casino_rounds(timestamp desc);

create table if not exists casino_events (
  id bigserial primary key,
  ts timestamptz not null default now(),
  type text not null,
  action text not null,
  agent text,
  result jsonb
);

create index if not exists idx_casino_events_ts on casino_events(ts desc);

create table if not exists casino_game_stats (
  game text primary key,
  total_rounds bigint not null default 0,
  total_wagered numeric not null default 0,
  total_paid_out numeric not null default 0,
  next_draw_time timestamptz
);

create table if not exists casino_commits (
  id bigserial primary key,
  agent text,
  game text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_casino_commits_status on casino_commits(status);
