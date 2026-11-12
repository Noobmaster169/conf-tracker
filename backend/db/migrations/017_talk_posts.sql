-- The Poster's highlight post of a finished talk, ready for X: one row per post written, the newest shown. Additive.
create table talk_posts (
  id         bigserial primary key,
  talk_id    bigint not null references talks (id),
  session_id uuid not null references sessions (id),
  call_id    bigint not null references llm_calls (id),
  text       text not null,
  created_at timestamptz not null default now()
);
create index talk_posts_talk_idx on talk_posts (talk_id, id);
