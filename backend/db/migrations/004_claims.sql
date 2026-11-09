-- Phase 3: claims. Additive only; the previous image never reads these tables.

-- One row per model call, ok or not: the audit trail behind every claim. input is the
-- rendered user message (the window and the prior claims); the system prompt is
-- src/agents/prompts/<step>/<prompt_version>.md in the repo, and a version is never edited.
create table llm_calls (
  id             bigserial primary key,
  session_id     uuid not null references sessions (id),
  step           text not null,
  prompt_version text not null,
  model          text not null,
  window_t0      double precision not null,
  window_t1      double precision not null,
  attempt        integer not null default 1,
  input          text not null,
  output         text,
  parsed         jsonb,
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       double precision,
  latency_ms     integer not null,
  error          text,
  created_at     timestamptz not null default now()
);
create index llm_calls_session_id_idx on llm_calls (session_id, id);

-- One row per claim the model returned, whatever the evidence check said. speaker_id,
-- t0 and t1 come from the transcript line the quote was found in, never from the model,
-- and are null when the quote was not found (status unverified).
create table claims (
  id             bigserial primary key,
  session_id     uuid not null references sessions (id),
  call_id        bigint not null references llm_calls (id),
  speaker_id     text,
  t0             double precision,
  t1             double precision,
  claim          text not null,
  topics         text[] not null default '{}',
  polarity       text not null check (polarity in ('bullish', 'bearish', 'neutral', 'none')),
  quote          text not null,
  quote_verified boolean not null,
  status         text not null check (status in ('ok', 'unverified', 'duplicate')),
  created_at     timestamptz not null default now()
);
create index claims_session_id_idx on claims (session_id, id);
create index claims_call_idx on claims (call_id);
