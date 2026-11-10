-- A stage used for a test run can be hidden: its schedule, its videos, their claims and the people known only from it
-- stay in the database and in the admin area, and leave every page a reader sees. Additive only.
alter table stages add column hidden boolean not null default false;
