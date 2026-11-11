-- A video survives failures: it is fed by several speech legs, each starting at a stream second, and the stretches
-- no leg covered are kept as gaps. Additive only: a rollback runs the previous image on this schema.
alter table sessions drop constraint sessions_status_check;
alter table sessions add constraint sessions_status_check
  check (status in ('starting', 'live', 'recovering', 'degraded', 'stopped'));
alter table sessions add column attention text;
alter table sessions add column recovering_since timestamptz;

create table session_legs (
  id            bigserial primary key,
  session_id    uuid not null references sessions(id),
  speech_id     text not null,
  kind          text not null check (kind in ('main', 'gap')),
  requested_t   double precision not null,
  start_t       double precision,
  end_t         double precision,
  opened_at     timestamptz not null default now(),
  ended_at      timestamptz,
  end_reason    text
);
create index session_legs_session_idx on session_legs (session_id, id);

create table session_gaps (
  id          bigserial primary key,
  session_id  uuid not null references sessions(id),
  t0          double precision not null,
  t1          double precision not null,
  filled_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index session_gaps_session_idx on session_gaps (session_id, t0);
