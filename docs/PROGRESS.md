# Progress

Phase 0 is current: local work done, box items pending (`docs/phases/phase-00-copy-and-stand-up.md`).

## Phases

Each phase is a branch with an exit checklist in `docs/phases/` and its own plan in
`docs/superpowers/plans/`, written when the phase starts.

0. Copy and stand up: yt-stream imported, renamed, re-ported, pointed at yt-stream's speech,
   conference baseline prompt, deploy, one past video, two-stream GPU measurement. Local done 2026-11-09.
1. Conferences and schedules: tables, admin pages, bulk paste, streams bound to a stage and day.
2. Session tracker: tracker loop, stage timeline, "now on stage", admin corrections with claim
   re-attribution, schedule-aware naming.
3. Enriched extraction and alerts: `extract/v4` with kind, importance, entities; alert rule,
   alerts table, dedupe, announcements rail, browser notifications.
4. Evaluation: past-video download path, labels, per-run numbers, the first tuning pass.
5. Live readiness: two live stages in parallel, runbook.

## Deployed

Not yet. `deploy/README.md` is the runbook.

## Deferred

Anything found outside the current phase's scope is written here, not built.

Carried over from yt-stream (still apply to the copied code):

- The SSE stream stays open, sending only pings, after a session stops; close it on a terminal status.
- `lag_s` is negative because ffmpeg starts from the HLS backlog and reads it faster than real time.
- A claim keeps the speaker its quote's line had at extraction time; a later relabel does not re-attribute it.
- Topics are free text; near-duplicates split the explorer's counts.
- `llm_calls.input_tokens` excludes cache reads.
- A quote from the middle of a long same-speaker run carries the run's start time, not the word's.
- The naming loop asks about every unnamed speaker each minute; consider backing off after N empty answers.
- A fast replay's runs see speaker names and merges from past their `upTo`.

New:

- Speech's `HlsSource` reads a past video's URL as fast as ffmpeg delivers, and the resolved URL can
  expire on a 6 to 9 hour video. Phase 4 downloads the audio first.

From the phase 0 review (deferred, not fixed):

- `.deployed` moves after `docker compose up -d` succeeds, not after the api is healthy; a commit whose
  migration crash-loops is marked deployed. Consider `up -d --wait` (the api has a healthcheck).
- A build that always fails is rebuilt every three minutes with its full output appended to `deploy.log`.
  Skip a failed sha until the next push, or back off.
- `run-ngrok.sh` exits silently when `NGROK_DOMAIN` is unset (nohup output goes to /dev/null); the runbook's
  "start ngrok detached" step gives no command. Log the error to `$LOG` and give the exact command.
- yt-stream's own auto-deploy restarts the shared speech service on any push touching `speech/`, which ends
  conf-tracker's live sessions (they go `degraded`, nothing reconnects). Phase 5 must handle or forbid it.
- conf-tracker's recordings land in `~/yt-stream/data/<uuid>/audio.raw` with no cleanup; 6 to 9 hour stage
  days grow it fast.
- yt-stream's `PyannoteDiarizer.diarize` calls one shared pipeline from several session threads without a
  lock. The two-stream measurement should also check speaker labels stay sane, not only lag.
- `.gitignore` still lists `speech/` paths.
