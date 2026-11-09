-- Nullable and additive, so the previous image still reads the table while a deploy rolls forward.
alter table sessions add column error text;
