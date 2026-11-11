# conf-tracker: a run that survives failures and covers the whole stream

Date: 2026-11-11. Status: reviewed by a builder check, open questions answered; awaiting the user's approval.

## 1. Intent

conf-tracker is going live on Breakpoint 2026 (London, 16 and 17 November): two stages at once, each one YouTube
livestream followed from the first word to the last. Tracking the entire conversation is the whole point of the
product, so a run must not lose any stretch of a stream, whatever breaks along the way.

Today one failure ends a run for good. On 2026-11-11 a deploy restarted the API 2 h 10 m into the 9-hour Accelerate
APAC recording (video `0ca0823d-a268-4049-b2e4-6c08afe1a780`); the run was marked `degraded`, the speech service
dropped its session, and the only way back was a new run from zero. The claims stopped even earlier, at 1 h 25 m,
because the extractor had fallen behind and its queued windows died with the process.

What we want instead: when something fails, the run continues from the second it failed, catches up the stretch it
missed (transcript, speakers, the session on stage, claims, summaries), then follows the stream again. The stored
result for a stage looks like that of a run that never broke: one video, one continuous timeline, every stretch
transcribed and extracted exactly once, the same voices with the same names.

The operator (the user) looks at the admin page once in a while, not all day. So recovery is automatic; a person is
only needed when the system cannot carry on by itself, and then the admin page says so plainly.

## 2. Goals, non-goals, anti-goals

Goals:

- A run comes through each of these without losing or repeating any stretch of the stream:
  1. the API restarts (a deploy, a crash, the box rebooting);
  2. the speech service restarts (a crash, the box rebooting, a yt-stream deploy that restarts it);
  3. the YouTube stream hiccups (network drops, the stream reconnecting);
  4. model calls fail (expired token, proxy down, rate limits, timeouts), for every step: tracking, extraction,
     naming, summaries.
- After any of these, the run resumes from the last second it has fully stored, catches up the missed stretch as
  fast as the box allows, and returns to following the stream live. No one has to press anything.
- A gap that cannot be caught up from the live stream (YouTube rewind turned off, or the rewind window has passed)
  is filled from the YouTube recording once the stream has ended, automatically.
- The same video row continues through every recovery (no second video card for one stage) and its voices keep their
  labels and names.
- The admin page shows, per running video: live, recovering ("catching up, 6 min behind"), or needs attention (with
  the reason and what to do), plus any stretch not yet covered.
- The extractor never skips transcript, outage or not: after an outage or while behind, it works through the backlog
  in order.
- Proven before Breakpoint: each failure above is caused on purpose during a test run and the result checked.

Non-goals:

- Push notifications (email, phone). The admin page is enough for an operator who checks in now and then. (My call:
  the user did not ask for them; easy to add later.)
- A stage moving to a new YouTube link mid-day. Each stage is one stream for the whole day, one link per stage
  (the user's answer), so a video never changes its source.
- Running extraction calls in parallel. Sequential catch-up is fast enough (an extract call covers up to 120 s of
  speech in about 10 s).
- A second GPU or a second speech process.

Anti-goals (it fails even if it technically recovers):

- A claim stored twice, or the same lines extracted twice, because a stretch was processed in two legs.
- A voice whose label or name changes after a recovery, or a claim attributed to the wrong person because labels
  restarted at S1.
- A live stage falling behind real time because another stage is catching up.
- A gap that is silent: any stretch not covered must be visible on the admin page until it is filled.
- Recovery that breaks yt-stream, which shares the speech service.

## 3. Constraints

- Deadline: live for Breakpoint, 16 November 2026. Today is 11 November. Leave at least one day for a full dry run on
  the box before the 16th.
- No shell on the box. The backend deploys by pushing to conf-tracker's `main` (auto-deploy, held while a video is
  live). The speech service is yt-stream's and deploys by pushing to yt-stream's `main`; its auto-deploy restarts the
  speech process (`pkill`), which ends every running session of both apps. So speech changes go out before the
  conference, never during.
- The speech service (`/root/ai/fiber/yt-stream/speech`) is shared with yt-stream. Everything new in its protocol is
  optional; a start message without the new fields behaves exactly as today.
- One GPU runs transcription and diarization for every session. Two live stages plus one catching up must fit.
- The model runs through the llm-proxy (`claude -p`), limited to 8 concurrent calls.

## 4. How it works

### 4.1 One video, several legs, one clock

A video (a `sessions` row) may be fed by several speech sessions over its life: the first one, and one more after each
failure. Call each a leg. The video's stream time is absolute: second 0 is the start of the broadcast (for a live
stream) or of the recording. Every leg reports times on that same clock, so segments, diarization turns, spans and
claims from different legs line up with no translation in the backend.

The speech service learns where to start from a new optional field in the start message, `start_at` (stream seconds).
Its clock starts at `start_at`, so every time it emits is already absolute.

How each kind of source starts at `start_at`:

- A recording (VOD): read from that offset.
- A live stream with YouTube rewind: read from the broadcast start (`--live-from-start`, as today) and drop audio
  before `start_at`, or seek directly if yt-dlp supports it for live DVR; then catch up at full speed and follow the
  live edge, as today.
- A live stream without rewind, or where `start_at` is older than the rewind window: start at the live edge. The leg
  reports the absolute time it actually started at; the stretch from `start_at` to there is a gap (4.6). The live
  edge's absolute time comes from the broadcast's start time (yt-dlp gives it) and the wall clock.
- A replay of a stored recording (`replay_of`): read the stored audio from the byte offset `start_at × 32000`.

The builder decides the exact yt-dlp/ffmpeg mechanics; the requirement is that the first sample a leg emits is at
the time it says, within a second.

### 4.2 The resume point

The backend keeps a video's resume point: the last stream second for which it has stored both transcript and
diarization. When a leg starts, the backend first deletes whatever it stored after the resume point (segments, words,
diarization turns and windows past it), so the new leg re-emits that stretch once. Writes become idempotent where a
duplicate could still slip through (for example a unique key on a segment's video and start time).

Claims, spans and summaries after the resume point are not deleted: they were made from lines before it (a claim's
quote is verified against stored lines). The extractor's own cursor (4.4) makes sure no line is extracted twice.

### 4.3 Reconnecting, by itself

The backend, not a person, brings a run back:

- When the speech socket closes unexpectedly, or speech is unreachable, or a leg ends with an error: the video
  goes to `recovering`, and the backend starts a new leg from the resume point, retrying with a backoff (seconds at
  first, at most a minute apart) for as long as the video is not stopped.
- When the API starts, every video that was `live`, `starting` or `recovering` is resumed the same way. This
  replaces today's `markOrphansDegraded`.
- A leg that ends because the source ended (`session.ended` with `source_ended`) ends the video normally: each stage
  is one YouTube stream for the whole day, and the organiser does not end it early or move to a new link (the
  user's answer). If YouTube ever reports the end wrongly, the admin's "resume" (below) carries the video on.
- A resume that finds the live stream already over (it ended while the API or speech was down) does not count as a
  failure: everything from the resume point to the broadcast's end becomes a gap (4.6), filled from the recording
  when YouTube serves it, and the video shows "stream ended, filling from the recording". (My call.)
- Only an admin's stop ends a video otherwise.
- Videos that were `degraded` before this work are not resumed by themselves (a blanket rule would wake old
  abandoned runs on the shared GPU). The admin page gets a "resume" action for a `degraded` or `ended` video, which
  starts a leg from its resume point. (My call.)
- Each day of a conference is its own stage, and so its own video (already how stages work: one stage of one
  conference on one day).
- After about 15 minutes of failing to get a leg running, the video also shows "needs attention" with the last
  error; it keeps retrying. (15 minutes is my call.)

The speech service's own retries inside a leg (re-probing and re-reading the stream) stay as they are.

### 4.4 The steps resume from stored progress, and never skip

Tracker, extractor and namer today keep their progress in memory and replay every interval boundary from 0 when
created. Instead:

- Each loop starts at the first boundary after its stored progress, not from 0.
- Extractor: its cursor (the end of the last window that was answered) is stored and read back. Its window still
  covers at most `extract_max_s` of fresh lines, but the window starts at the cursor: when behind, it takes the next
  `extract_max_s` after the cursor, and keeps going until it reaches the latest line. Nothing is skipped. This
  replaces the bound in `backend/src/pipeline/window.ts`, which today jumps to the last 120 s and drops what was
  before.
- A failed extract call leaves the cursor where it is and is retried with a backoff; the extractor does not move past
  a window until it has an answer.
- Tracker: its belief (the open span) is already in the database; it continues from there.
- Namer: names are in the database; it names the newest window (`latestOnly`, as now).
- Summaries: a talk whose span closed without a summary is retried until it has one. This includes summaries that
  failed before a restart.

### 4.5 Voices keep their labels

The speech service's speaker registry (centroids, the S-number counter) lives in memory today, so a new leg would
start again at S1 and the backend would silently merge a different voice into the old S1 row and give it that name.

Instead the speech service saves the registry for each speech session next to its recording (after each diarization
step) and loads it when a leg starts with `start_at`. A voice heard in an earlier leg gets its old label; a new voice
gets the next number. Merges carry over. The backend's speaker rows and names then stay right with no change.

A video whose earlier legs ran before this work has no saved registry (the Accelerate APAC test video is one). Its
next leg starts voices fresh, numbered after the highest label the video already has so nothing collides, and the
namer names them again. No re-diarizing of old recordings. (My call.)

The backend tells speech which earlier recording's registry to load (the speech session id the previous leg used),
so the legs can use their own ids. Whether legs share one speech session id (and one `audio.raw`, truncated to
`start_at` and appended to) or each have their own is the builder's call; the requirements are that the video's
recording can be replayed whole afterwards, and that the registry carries over.

### 4.6 Gaps

A gap is a stretch of a video's stream time with no transcript: a leg started at the live edge, later than its
`start_at`; or the run started after the broadcast did on a stream without rewind (second 0 is always the broadcast
start, so the stretch before the first leg is a gap too); or the stream ended while the run was down (4.3). The
backend stores each gap. While a video has gaps, its admin page lists them.

With rewind, catch-up happens in place, before the run moves on, so most failures never leave a gap. Gaps are the
rarer case, and they are filled after the stream has ended, when the rest of the video is already processed.

When the recording is available on YouTube, the backend fills each gap with a leg over the recording, from the gap's
start to its end (`start_at` plus a new optional `stop_at`). Filling a gap is not append-only; the steps go back for
it (my call, because a claim must land in the right talk with the right speaker):

- The extractor extracts the gap's lines with a cursor of its own for the gap, deduping against the claims stored
  just before and after the gap, not the latest ones.
- The tracker reads the gap and may rewrite the spans that touch it: shorten or split the spans either side, or
  open a talk that began inside the gap. Claims inside the gap take the talk whose span covers them.
- Each talk whose span overlaps the gap gets its summary written again once the gap is filled.
- The namer names any voice first heard inside the gap.

If the recording never becomes available (removed or private), the gap stays and the admin page shows it.

### 4.7 What the admin sees and can do

Per running video, on the admin page and on the video's page:

- live, with how far behind real time it is;
- recovering: what failed, since when, and how far behind;
- needs attention: why, and what the operator can do;
- gaps not yet filled.

The operator can stop a video, and resume a `degraded` or `ended` one (4.3). Nothing else should ever be needed:
the point of this work is that D-Day failures are handled without the operator, and that when they do look, one
glance at the admin page tells them every stage is covered, or exactly what is not and why.

### 4.8 Sharing the GPU

A leg catching up reads faster than real time and competes with the other stage's live leg. The speech service
paces a catching-up leg so live legs stay at real time: a speed cap per leg (`speed`, which already exists for files),
or a priority for legs at the live edge. The builder measures how much catch-up speed the GPU can give with two live
stages (from the `health` events: `gpu_ms_asr`, `gpu_ms_diar`, `lag_s`) and sets the default from that.

### 4.9 Deploys

- conf-tracker's auto-deploy already holds an API restart while a video is live. Keep it. With this work an API
  restart is survivable, but it still costs a catch-up.
- yt-stream's auto-deploy restarts the speech process with no hold. Give it the same hold: no speech restart while
  any session (of either app) is running, unless forced. (Speech knows its running sessions; it can answer a
  health check.)

## 5. Testing

Unit and integration tests for each piece (start_at and stop_at in the source, registry save and load, resume point
and the deletion after it, loop progress from storage, the extractor's catch-up without skipping, retries with
backoff, gaps). Plus, on the box, before Breakpoint, with a long recording run as a video and with a real livestream:

1. restart the API mid-run;
2. restart the speech service mid-run;
3. make the model fail for a few minutes (a wrong token through the ops API), then put it back;
4. for a live stream, stop the run's speech leg long enough to need catch-up from rewind.

After each, check: no stretch missing from the transcript, no line extracted twice, no claim duplicated, voice labels
and names unchanged across the failure, the video's status went live → recovering → live.

The first real use: the Accelerate APAC test video `0ca0823d-a268-4049-b2e4-6c08afe1a780` stopped at 2:09:40 (claims
to 1:25:00). Resumed with the admin's "resume", it should cover the rest of the 9 hours and extract 1:25:00 onwards,
on the same video. Its voices after 2:09:40 start fresh and are named again (4.5), so for this video the check is
"no collision and names come back", not "labels unchanged".

## 6. Left to the builder

- The yt-dlp/ffmpeg mechanics for starting at an offset, for each kind of source, and for the live edge's absolute
  time.
- Storage shapes: where the extractor cursor and loop progress are kept, how legs and gaps are recorded, which
  unique keys make writes idempotent.
- Whether legs share a speech session id and recording file or each have their own (4.5).
- Backoff numbers, and the speed cap default after measuring the GPU.
- How the admin page shows the statuses, within the existing design.
