-- Phase 4: names. Additive only; the previous image never reads these columns or this table.

-- The name a speaker goes by now, with the quote and the call that gave it. Null until a proposal is accepted.
alter table speakers
  add column name            text,
  add column role            text,
  add column name_confidence double precision,
  add column name_quote      text,
  add column name_call_id    bigint references llm_calls (id);

-- Every name the model proposed, accepted or not, and why a rejected one lost: the audit trail of a name.
create table name_proposals (
  id             bigserial primary key,
  session_id     uuid not null references sessions (id),
  call_id        bigint not null references llm_calls (id),
  speaker_id     text not null,
  name           text not null,
  role           text,
  confidence     double precision not null,
  quote          text not null,
  quote_verified boolean not null,
  status         text not null check (status in ('accepted', 'rejected')),
  reason         text,
  created_at     timestamptz not null default now()
);
create index name_proposals_session_speaker_idx on name_proposals (session_id, speaker_id, id);
create index name_proposals_call_idx on name_proposals (call_id);
