-- The conference layer: stages with a schedule, people, the timeline of who is on stage, and a summary per talk.
-- Additive only; the previous image never reads these tables or columns.
--
-- Naming: a row of `sessions` is one ingestion of one video (the app calls it a video). A scheduled
-- conference session is a `talk` here, so the two never share a word in the code.

-- One stage of one conference on one day: the unit a schedule and a livestream both belong to.
create table stages (
  id          uuid primary key default gen_random_uuid(),
  conference  text not null,
  name        text not null,
  day         date,
  -- What the conference is about, in a sentence or two. Goes into the prompts as context.
  description text not null default '',
  created_at  timestamptz not null default now()
);

-- A speaker as a person, across every video. A diarized label of one video (speakers) points here once it is named.
create table people (
  id         bigserial primary key,
  name       text not null,
  org        text,
  title      text,
  photo_url  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index people_name_key on people (lower(name));

-- One entry of a stage's schedule. Times are the planned local times as printed ("14:30"): context, never a clock.
create table talks (
  id          bigserial primary key,
  stage_id    uuid not null references stages (id),
  title       text not null,
  description text not null default '',
  kind        text not null default 'talk' check (kind in ('talk', 'panel', 'fireside', 'keynote', 'break', 'other')),
  starts_at   text,
  ends_at     text,
  position    integer not null default 0,
  -- Removed from the schedule by the admin. The row stays: spans and summaries may point at it.
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create index talks_stage_idx on talks (stage_id, position, id);

create table talk_speakers (
  talk_id   bigint not null references talks (id),
  person_id bigint not null references people (id),
  role      text not null default 'speaker' check (role in ('speaker', 'moderator', 'host')),
  primary key (talk_id, person_id)
);

alter table sessions
  add column stage_id uuid references stages (id),
  add column title    text;

alter table speakers add column person_id bigint references people (id);

-- What is on stage, as a run of spans per video. At most one is open (t1 null) per video; a new span closes the
-- one before it. A claim belongs to the talk whose span covers its t0, so a corrected span re-attributes claims
-- with no write to them.
create table talk_spans (
  id         bigserial primary key,
  session_id uuid not null references sessions (id),
  talk_id    bigint references talks (id),
  state      text not null check (state in ('talk', 'break')),
  t0         double precision not null,
  t1         double precision,
  confidence double precision,
  quote      text,
  source     text not null check (source in ('tracker', 'admin')),
  call_id    bigint references llm_calls (id),
  created_at timestamptz not null default now()
);
create index talk_spans_session_idx on talk_spans (session_id, t0);
create index talk_spans_talk_idx on talk_spans (talk_id);

-- Null on claims extracted before extract/v4.
alter table claims
  add column kind       text check (kind in ('announcement', 'metric', 'roadmap', 'opinion', 'fact')),
  add column importance integer check (importance between 1 and 5);
create index claims_recent_idx on claims (id desc) where status = 'ok';

-- One row per summary written for a talk; the newest is the one shown.
create table talk_summaries (
  id         bigserial primary key,
  talk_id    bigint not null references talks (id),
  session_id uuid not null references sessions (id),
  call_id    bigint not null references llm_calls (id),
  summary    jsonb not null,
  created_at timestamptz not null default now()
);
create index talk_summaries_talk_idx on talk_summaries (talk_id, id);
