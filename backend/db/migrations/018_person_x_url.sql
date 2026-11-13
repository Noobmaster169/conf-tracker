-- A person's profile on X (Twitter), as a link. Additive only.
alter table people add column if not exists x_url text;
