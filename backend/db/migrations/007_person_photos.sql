-- A person's photo, kept here so it outlives the link it was found at (a conference site's image links expire).
-- Additive only. people.photo_url points at the api's own /people/:id/photo when a row exists here.
create table person_photos (
  person_id    bigint primary key references people (id),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes        bytea not null,
  updated_at   timestamptz not null default now()
);
