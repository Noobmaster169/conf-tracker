-- "Which rows are a run's last attempt" looks up the other rows over the same window of the same agent on the same
-- video. The Watcher asks that for every agent of every video it watches, once a minute; without this index the
-- lookup scans the video's calls for each row, which grows with the square of a stream's length. Additive.
create index llm_calls_run on llm_calls (session_id, step, window_t0, window_t1, id);
