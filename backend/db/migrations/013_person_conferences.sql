-- A conference a person is listed for without a session on a tracked stage yet: a speaker on the official list whose
-- talk is not announced, or on a stage nobody tracks. The people list groups by conference from this, the schedule
-- and the videos they were heard in. Additive only.
create table person_conferences (
  person_id  bigint not null references people(id) on delete cascade,
  conference text not null check (length(btrim(conference)) > 0),
  created_at timestamptz not null default now(),
  primary key (person_id, conference)
);
