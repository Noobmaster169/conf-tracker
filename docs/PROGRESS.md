# Progress

Phase 0's box items are still pending (`docs/phases/phase-00-copy-and-stand-up.md`).

2026-11-10, the app revamp (branch `revamp/conference-app`): the dashboard was replaced by five pages (Videos, Monitor,
Sessions, Speakers, Admin) and the backend gained the conference layer they need. This pulled most of phases 1 and 2
and parts of 3 forward, and added per-session summaries, which the design had listed as a non-goal:

- Built: stages, schedules (form and paste), people, videos bound to a stage, the tracker loop and timeline, admin
  correction of what is on stage, schedule-aware naming with person linking, `extract/v4` with kind and importance,
  a summary per finished session, the feed and card routes.
- The summary is a markdown article written with yt-engine's summary prompt (`lib/summaries/prompts/summary.md` on its
  `main`, as of 2026-11-10), adapted only where a conference session differs from a video: the speaker-attributed
  transcript format, the schedule header, attribution by name. Same word ranges by length, same model tier (`opus`),
  same 8192 token ceiling. It is `summarize/v1` here; when yt-engine's prompt improves, port the diff.
- Verified only with fakes and scripted answers (`pnpm simulate --scripted`): no model login and no speech service were
  reachable from the dev machine. **The four new prompts have never been run against a real model or a real stream.**
  First thing to do on the box: one past conference video on a stage with its real schedule.
- Removed from the frontend: the claims explorer, compare, replay panel, audit drawer, speaker and topic panels and the
  status bar. Their backend routes (`/claims`, `/calls`, replay, topics) are still there.
- Not built: alerts and browser notifications, alert dedupe, re-extraction after a tracker switch, the drift hint from
  wall-clock time, entities and `first_party`, the evaluation view, a separate admin secret, a photo upload field in the admin
  form (a photo is a link the admin pastes, or is sent to `PUT /people/:id/photo`).
- Speaker photos can be stored: `person_photos` (migration 007) keeps the bytes, `PUT /people/:id/photo` takes a base64
  JSON body and points `people.photo_url` at `/people/:id/photo?v=...`, and the frontend reads it through
  `/api/photo/[id]` so the backend key stays server-side. Built because the conference site's image links expire.
- Test runs can be hidden: `stages.hidden` (migration 008, a tick box on the stage in Admin). A hidden stage's sessions,
  videos and claims leave Videos, Monitor, Sessions and Speakers; a speaker is hidden with it only if they first appeared
  after that stage was created and are on nothing shown. Admin still lists everything (`/videos?all=1`,
  `/people?all=1`), and a hidden video or session still opens by its link. A video with no stage is hidden by moving it
  onto a hidden stage.
- `DELETE /people/:id` (Admin, Speakers, "Remove speaker") removes someone on no session and heard in no video.

2026-11-11, running it with no access to the box (`CLAUDE.md`, `deploy/README.md` "Without the box"): the box will be
out of reach during the conference, so everything a shell was used for got a way through the api or through git.

- `/ops/status`, `/ops/logs`, `/ops/sql` (read-only), `/ops/jobs` (a fixed list of things the box does when asked),
  the box's own report on every cron pass, and `ops/ct` to call them.
- Prompts and settings change with no build and no restart: a prompt version can be registered through the api
  (`prompt_overrides`), a running video's config can be patched and its loops read it at every run, and the config new
  videos start from is a stored setting (migration 009).
- `auto-deploy.sh` holds back a deploy that restarts the api while a video runs, waits for `/health` before it moves
  the marker, puts the previous image back when the new one does not come up, stops retrying a commit that failed, and
  runs `deploy/ops.d/*.sh` once each.
- Not built: resuming a video after an api restart. Speech starts every connection at the stream's first second with
  fresh speaker labels, so a resume needs a start offset and a label hand-over in yt-stream's speech service.
- Not built: a second way to hear from the box when the tunnel is down. `git push` still reaches it then, blind.

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

- The tracker cannot represent a session that is not on the schedule: it answers `unknown` and the previous belief stands, so an unscheduled talk's claims are filed under the session before it until the admin corrects it.
- A span is rewritten or closed in place; superseded tracker verdicts are not kept as rows (the call that produced each is).
- A summary is written once, when the session leaves the stage. Claims extracted or re-attributed later do not refresh it; the admin can ask for it again.
- `people` are matched by exact name. Two different people with one name share a row, and a name heard two ways off-schedule makes two.
- Monitor polls every five seconds per open tab instead of using a conference-wide SSE channel.
- The video page of a long recording renders the whole transcript at once.

- Fixed 2026-11-10 in yt-stream's speech (`YoutubeSource`): a past video is read once at full speed and the stream ends
  when it does, and a live stream is read from its first second (catching up at several times real time) and then
  followed. Before this a past video was read in a loop: the first production run transcribed a 22 minute panel 13 times.
  A dropped connection re-reads from the top and skips what was delivered, so it costs a re-download, not a duplicate.
- On a fast run the loops finish well after the transcript does: model calls queue on stream time and are worked through
  in order. A summary may be written before the namer has reached that talk's speakers, so it can lack a name the
  transcript later shows.
- A live stream with rewind disabled cannot be read from its start; speech falls back to joining at the live edge.
- A stream that has not started yet ("scheduled") is refused by yt-dlp and the video ends with an error; start it once
  it is live.

From the phase 0 review (deferred, not fixed):

- Done 2026-11-11: `.deployed` now moves only once the api answers `/health`, and a build that keeps failing is
  left alone after three tries.
- `run-ngrok.sh` exits silently when `NGROK_DOMAIN` is unset (nohup output goes to /dev/null); the runbook's
  "start ngrok detached" step gives no command. Log the error to `$LOG` and give the exact command.
- yt-stream's own auto-deploy restarts the shared speech service on any push touching `speech/`, which ends
  conf-tracker's live sessions (they go `degraded`, nothing reconnects). Phase 5 must handle or forbid it.
- conf-tracker's recordings land in `~/yt-stream/data/<uuid>/audio.raw` with no cleanup; 6 to 9 hour stage
  days grow it fast.
- yt-stream's `PyannoteDiarizer.diarize` calls one shared pipeline from several session threads without a
  lock. The two-stream measurement should also check speaker labels stay sane, not only lag.
- `.gitignore` still lists `speech/` paths.
