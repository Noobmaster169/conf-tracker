-- Phase 2: speakers. Additive only; the previous image never reads these tables.

-- One row per registry speaker of a session. merged_into names the survivor when the registry folded this one in.
create table speakers (
  session_id   uuid not null references sessions (id),
  speaker_id   text not null,
  first_seen_t double precision not null,
  last_seen_t  double precision not null,
  talk_s       double precision not null default 0,
  merged_into  text,
  created_at   timestamptz not null default now(),
  primary key (session_id, speaker_id)
);

-- One row per diarization window, with every local speaker's scores: the audit trail of a label.
create table diar_windows (
  id         bigserial primary key,
  session_id uuid not null references sessions (id),
  t0         double precision not null,
  t1         double precision not null,
  gpu_ms     double precision not null,
  matches    jsonb not null,
  created_at timestamptz not null default now()
);
create index diar_windows_session_t0 on diar_windows (session_id, t0);

-- Turns as each window saw them. Rows are never superseded in place: for any instant the
-- window with the latest t0 covering it is in force (backend/src/pipeline/timeline.ts).
create table turns (
  id         bigserial primary key,
  session_id uuid not null references sessions (id),
  window_id  bigint not null references diar_windows (id),
  t0         double precision not null,
  t1         double precision not null,
  speaker_id text not null
);
create index turns_session_t0 on turns (session_id, t0);
