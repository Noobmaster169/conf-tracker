-- "Mark resolved" by hand: the incident stops being shown as open, but stays the open row for its rule, agent and
-- video, so trouble that is still there is not reported again a minute later. It closes for good when the trouble goes.
alter table incidents add column acknowledged_at timestamptz;
