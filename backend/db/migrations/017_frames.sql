-- Pictures of the stage, one row per frame kept (docs/superpowers/specs/2026-11-13-frames-design.md). The images live in
-- Cloudflare R2 under `key` and `thumb_key`; only the keys are here. A frame belongs to the talk whose span covers its
-- t, decided at read, as a claim does. Additive.
create table frames (
  id         bigserial primary key,
  session_id uuid not null references sessions (id),
  t          double precision not null,
  key        text not null,
  thumb_key  text not null,
  width      integer not null,
  height     integer not null,
  -- 64x36 grey, one byte per cell, row by row: what the next grab is compared against.
  sig        bytea not null,
  -- One byte per cell, 1 where the picture moved between this grab and the next (the speaker beside a slide).
  motion     bytea not null,
  hidden     boolean not null default false,
  -- A hidden frame that also keeps anything like it out of every video's gallery (a break card, a sponsor loop).
  blocked    boolean not null default false,
  created_at timestamptz not null default now()
);
create index frames_session_idx on frames (session_id, t);
create index frames_blocked_idx on frames (id) where blocked;
