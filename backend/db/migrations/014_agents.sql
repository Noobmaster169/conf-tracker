-- Agents: what was changed about one (or tried on one of its calls), and what the Watcher found wrong. Additive.
-- An agent is identified by llm_calls.step, so nothing here needs the calls already stored to change.
create table agent_events (
  id         bigserial primary key,
  agent_id   text not null,
  session_id uuid references sessions (id) on delete cascade,
  call_id    bigint references llm_calls (id) on delete cascade,
  kind       text not null check (kind in ('change', 'rerun')),
  summary    text not null,
  data       jsonb not null default '{}',
  actor      text not null default 'unknown',
  created_at timestamptz not null default now()
);
create index agent_events_agent on agent_events (agent_id, id desc);
create index agent_events_call on agent_events (call_id) where call_id is not null;

create table incidents (
  id           bigserial primary key,
  rule         text not null,
  agent_id     text,
  session_id   uuid references sessions (id) on delete cascade,
  call_id      bigint references llm_calls (id) on delete set null,
  parent_id    bigint references incidents (id) on delete set null,
  title        text not null,
  detail       text not null default '',
  diagnosis    text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  count        int not null default 1,
  clear_passes int not null default 0,
  resolved_at  timestamptz
);
-- One open incident per rule, agent and video: the same trouble seen again updates it.
create unique index incidents_open on incidents (rule, coalesce(agent_id, ''), coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)) where resolved_at is null;

create index llm_calls_step on llm_calls (step, id desc);
