-- One ingestion of one stream. Never deleted: a session is what gets audited later.
create table sessions (
  id          uuid primary key default gen_random_uuid(),
  source_url  text,
  source_file text,
  status      text not null default 'starting'
              check (status in ('starting', 'live', 'degraded', 'stopped')),
  started_at  timestamptz,
  stopped_at  timestamptz,
  config      jsonb not null default '{}'::jsonb,
  models      jsonb not null default '{}'::jsonb,
  replay_of   uuid references sessions (id),
  created_at  timestamptz not null default now()
);

-- One row per asr.segment. words: [{w, t0, t1, p, speaker_id}], speaker_id null until phase 2.
create table segments (
  id         bigserial primary key,
  session_id uuid not null references sessions (id),
  t0         double precision not null,
  t1         double precision not null,
  text       text not null,
  words      jsonb not null,
  created_at timestamptz not null default now()
);
create index segments_session_t0 on segments (session_id, t0);

-- The raw feed from speech, in arrival order, for replay and debugging.
create table events (
  id          bigserial primary key,
  session_id  uuid not null references sessions (id),
  seq         integer not null,
  type        text not null,
  payload     jsonb not null,
  received_at timestamptz not null default now(),
  unique (session_id, seq)
);
