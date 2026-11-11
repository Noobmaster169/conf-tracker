-- Which talk a summarize call was for, so a failing summary can back off per talk. Additive: nullable, null on every other step.
alter table llm_calls add column talk_id bigint;
create index llm_calls_talk_idx on llm_calls (talk_id) where talk_id is not null;
