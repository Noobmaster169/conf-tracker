-- Running the stack with no shell on the box (deploy/README.md, "Without the box"). Additive only.

-- Small named values the api keeps: the box's last report of itself, and the config a new video starts from.
create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- A prompt version registered through the api, so a prompt can change without a build or a restart. It is read before
-- the files in src/agents/prompts, so the same step and version here replaces the file's text.
create table prompt_overrides (
  step       text not null,
  version    text not null check (version ~ '^v[0-9]+$'),
  model      text not null,
  max_tokens integer,
  text       text not null,
  updated_at timestamptz not null default now(),
  primary key (step, version)
);

-- Work asked of the box through the api. deploy/box-ops.py on the box takes the oldest queued job on each cron pass,
-- runs it if its verb is one it knows, and writes back what happened.
create table ops_jobs (
  id          bigserial primary key,
  verb        text not null,
  args        jsonb not null default '{}',
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  output      text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index ops_jobs_status_idx on ops_jobs (status, id);
