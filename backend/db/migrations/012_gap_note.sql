-- Filling a gap is a staged job that resumes where it stopped. Additive only: every column nullable.
--   note:      why filling was given up (shown on the admin page);
--   stage:     the last step done (transcribed, tracked, named, extracted, summarised), null before the transcript;
--   stage_at:  when it got there; a talk summarised since then counts as summarised for this gap;
--   tried_at:  when a step last failed or was refused: the next try waits 15 minutes;
--   since:     the first try of the current attempt to transcribe it: given up only a day after.
alter table session_gaps add column note text;
alter table session_gaps add column stage text check (stage in ('transcribed', 'tracked', 'named', 'extracted', 'summarised'));
alter table session_gaps add column stage_at timestamptz;
alter table session_gaps add column tried_at timestamptz;
alter table session_gaps add column since timestamptz;
