# conf-tracker: design

Date: 2026-11-09. Status: reviewed by a builder check, open questions answered; awaiting the user's approval.

## 1. Intent

Track crypto conferences (Breakpoint, Accelerate and the like) as they happen. Each conference
stage is one YouTube livestream. While people talk, the system pulls out what matters:
announcements, launches, partnerships, new numbers, roadmap dates, and the opinions and alpha
speakers share on stage. Important items land on an announcements list and raise an alert the
moment they are detected.

What makes it more than `yt-stream` pointed at a conference: **the schedule is known**. The
operator enters each stage's agenda (sessions, speakers, planned times) from the conference
website. That agenda is an attention layer: at any moment the system holds a belief about which
session is on stage, who is speaking and what the session is about, and extraction runs with
that context. A "we are launching X next month" from the founder of X on a session titled
"X: what's next" is an announcement; the same words from a moderator's aside are not.

The schedule is context, never a clock. Sessions run long or short, start late, get swapped,
breaks move, the stream starts before the first talk. The current session is inferred from
what is heard, with the schedule as the candidate list.

Past conferences (full recorded stage streams on YouTube, all sessions back to back) go through
the same pipeline, as videos instead of livestreams. They are the test bed: run, replay with
different settings, compare, tune. What counts as "important" is not defined up front; it starts
broad and is refined by evaluating on past videos.

## 2. Goals, non-goals, anti-goals

Goals:

- Live feed per stage: video, transcript, current session, extracted claims.
- An announcements list per conference across its stages, filled automatically, with an alert in
  the browser when an important item lands.
- Every claim carries the session and speaker it belongs to (from the schedule), and every alert
  is auditable back to the transcript and the model call, as in `yt-stream`.
- Two stages tracked live in parallel.
- Past stage videos runnable as sessions, replayable and comparable, to tune extraction and
  session tracking.
- Admin area: enter and edit conferences, stages and schedules; correct the current session or
  past session boundaries by hand; corrections re-attribute claims already extracted.

Non-goals (for now):

- Summaries or digests per session or per day.
- Telegram or any push outside the browser. The alert step is a pluggable notifier so Telegram
  is a later addition, not a rewrite.
- Scraping schedules from conference websites. The operator enters them.
- Labelled accuracy research beyond what the evaluation loop in section 8 needs.

Anti-goals (a failure even if it technically works):

- **Alert noise.** If every pleasantry, sponsor read or vague "we're excited about the future"
  pings, the alerts are useless. Precision on alerts matters more than recall.
- **Trusting the schedule's times.** Attributing a claim to the session the clock says rather
  than the one actually on stage.
- **Wrong attribution presented confidently.** A claim attributed to the wrong speaker or project
  is worse than one with no attribution. Low confidence is shown as such.
- **Unauditable alerts.** An alert with no path back to the quote and the call that produced it.

## 3. Approach: copy yt-stream, then extend

`yt-stream` (`/root/ai/fiber/yt-stream`, commit `bdb3240`) already does the hard part: HLS
ingest, faster-whisper ASR, windowed pyannote diarization with a speaker registry, speaker
naming, claim extraction with an evidence check, every LLM call stored, SSE, replay at any speed
on stream time, compare page, deploy on the Monash box with ngrok and Vercel, the `claude -p`
proxy. Its design is `yt-stream/docs/superpowers/specs/2026-09-23-live-stream-ingestor-design.md`
and its open issues are in `yt-stream/docs/PROGRESS.md`; both are required reading.

Decision (mine): **copy `backend`, `frontend`, `proxy` and `deploy` into this repo as a fresh git
history**, with a first commit
that records the source commit. Not a git fork: the two will diverge and nothing is shared at
runtime. Not a rewrite: the pipeline works and has been tuned. Then rename, move ports, strip
what does not apply, and build the conference layer on top.

All of yt-stream's engineering rules carry over unchanged (zod at every boundary, SQL only in
repositories, files under 200 lines, forward-only migrations, stream-time loops, every model call
stored, failures stored not swallowed, no emoji, no em dashes).

**Speech is not copied (user's decision).** conf-tracker uses yt-stream's running speech service
on the box (the same WebSocket `/sessions` protocol, port 8100 on the docker bridge). Consequences:

- The speech service and its GPU are shared with yt-stream; its sessions and conf-tracker's run in
  the same process on the same loaded models.
- Any speech-side change this project needs (a concurrency priority for live streams, for
  instance) is made in the yt-stream repo and must stay backward compatible with yt-stream's
  backend.
- Session ids must not collide across the two backends (both use UUIDs; keep it that way), since
  speech keeps `data/<session_id>/` per session in one data root.

What changes in the copy:

- Bloomberg-specific prompt content (market polarity) is replaced by the conference prompt (5.3).
- The claims explorer becomes per conference.
- Ports and names move so the stack sits beside yt-stream on the box (section 9).
- The LLM proxy is its own copy and container, on the same `claude -p` subscription
  (user's decision): no API key, no per-call budget.

## 4. Domain model

```
conference ─┬─ stage ─┬─ schedule_session ── schedule_speaker (name, org, role)
            │         └─ stream (= a yt-stream "session": one ingestion of one video or livestream)
            └─ alerts (across stages)
```

- **conference**: name, dates, timezone, a short description (what the conference is about, the
  ecosystem, the notable projects), used as prompt context.
- **stage**: belongs to a conference; name ("Main stage", "Stage 2").
- **schedule_session**: belongs to a stage; title, description, kind (`talk`, `panel`,
  `fireside`, `keynote`, `break`, `other`), planned start and end (local time of the conference),
  order within the day, speakers. Editable at any time, including mid-stream.
- **schedule_speaker**: name, organisation, role, optional handle; a speaker can appear in several
  sessions.
- **stream**: today's yt-stream session row, plus `stage_id` and `day`. Live or past video, same
  table. Replays keep `replay_of`.

Schedule entry in the admin area: a form per session, and a bulk paste (CSV or JSON, one row per
session) because a conference day is 20 to 40 sessions per stage. The import format is the
builder's call; it must round-trip (export what was entered, edit, re-import).

## 5. Pipeline

Unchanged from yt-stream: speech (ASR, diarization, registry) to backend over WebSocket, every
event stored, SSE to the frontend, loops on stream time.

New, in the backend, per stream:

```
segments ─▶ session tracker ─▶ stage timeline ─┐
    │                                          ├─▶ extractor (context-enriched) ─▶ claims ─▶ alert rule ─▶ alerts ─▶ notifiers
    └─▶ namer (schedule-aware) ─▶ speakers ────┘
```

### 5.1 Session tracker (the attention layer)

A stream-time loop, default every 60 s, one LLM call:

- Input: the last few minutes of transcript (default 4 min, speaker-attributed, names where
  known); the current belief and how long it has held; a candidate list drawn from the stage's
  schedule: the current session, the previous one, the next three, plus any session whose speakers
  match a named speaker in the window; and a soft time hint (planned times, and the drift the
  stream has shown so far, e.g. "running 25 min late").
- Output: `state` (`session` with a schedule_session id, `break`, `transition`, `off_schedule`,
  `unknown`), confidence, and a verbatim quote as evidence (checked like claim quotes). Strong
  evidence is an MC hand-off ("please welcome...", "next up..."), a self-introduction, the
  session title said aloud, or a scheduled speaker being named.
- Hysteresis: the belief changes only when two consecutive reads agree, or one read with high
  confidence and verified evidence. A change backdates the boundary to the start of the evidence
  line, not the moment of the read, so claims from the first minute of a session get the right
  attribution.
- Out-of-order and unscheduled are first class: a session can run in any order; a talk that is not
  on the schedule is `off_schedule` and gets a placeholder the admin can fill in later.

The result is the **stage timeline**: rows `(stream_id, t0, t1, state, schedule_session_id,
confidence, source = tracker | admin, call_id)`. Like diarization turns, a new verdict
supersedes the old one for its range and the superseded rows are kept.

**Admin overrides win.** "Session 5 from 14:20" writes an `admin` row; the tracker never
overrides an admin row and resumes after it (a "from here on, it is session 5" correction becomes
the tracker's current belief). Any timeline change re-attributes claims whose `t` falls in the
changed range: their `schedule_session_id` is updated and pushed over SSE, and their alert status
is re-evaluated. Re-extraction is not triggered by a correction (cost), but the stream can be
replayed if needed.

Drift is also cheap context for the next sessions: once session 3 started 25 min late, session 4
is expected about 25 min late too.

**Tracker switches and extraction (my call).** The first minutes of a talk are where "today we're
launching X" is said, and they are extracted before the tracker has switched. So:

- While the timeline state is `transition` or `unknown`, claims are stored as usual but held back
  from alerting.
- When the tracker switches and backdates a boundary, the backdated range (capped at 3 min) is
  re-extracted once with the new session's context. The new claims supersede the earlier ones from
  that range (kept, marked `superseded`), and only then do held claims go through the alert rule.
- Admin corrections only re-attribute (no re-extraction), as above.

**Wall clock for past videos (my call).** The drift hint needs the wall time of stream `t = 0`.
For a recorded livestream, yt-dlp's `release_timestamp` (the live start) gives it; when it is
missing the operator enters it on the stream, and with neither the tracker runs without the time
hint.

### 5.2 Schedule-aware naming

The namer's question changes from "who is this?" to "which of these scheduled speakers is this,
if any?". It gets the current session's speakers (names, orgs, roles) plus the moderator and the
MC if known. Matching to a scheduled speaker attaches the org and role, which extraction needs to
resolve "we" and "our". Free naming (someone not on the schedule) stays possible, as today.

### 5.3 Context-enriched extraction

Same loop and evidence check as yt-stream (every 30 s of stream time, new lines plus a context
tail, the last claims as "already extracted"). New in the prompt (a new version, `extract/v3`):

- conference description; current session title, description, kind and speakers with orgs; the
  timeline state (in session, break, transition). During `break` the extractor skips the call.
- line prefixes carry the resolved speaker with org: `[mm:ss S3 Jane Doe, Acme]`.

New in each claim:

- `kind`: `announcement` (launch, release, date, partnership, funding, listing), `metric` (a new
  number: users, TVL, revenue, throughput), `roadmap` (a plan with or without a date), `opinion`
  (a view, a prediction, alpha), `fact` (other checkable information). The list is a starting
  point and expected to change during evaluation.
- `importance`: 1 to 5, with a rubric in the prompt (5: first-party announcement of something
  new and concrete; 1: background fact). The rubric is the main thing evaluation tunes.
- `first_party`: whether the speaker is announcing for their own organisation. Derived, not asked
  of the model (my call): the speaker's org from the schedule compared with the claim's entities,
  so it updates when a correction changes the session or speaker.
- `entities`: projects, companies, tokens, people the claim is about (normalised names).
- the existing `claim`, `topics`, `quote`; `polarity` is kept as optional sentiment.
- from the timeline, not the model: `schedule_session_id` and session confidence.

### 5.4 Alerts

An alert is a claim that passes the **alert rule**: a pure function of the claim and the session
config, default `importance >= 4`, configurable per conference (thresholds by kind, first-party
only, entity watchlist). Kept as a rule over stored claims, not a model decision, so changing it
re-evaluates history without model calls.

- `alerts` table: claim id, conference, stage, stream, status (`new`, `seen`, `dismissed`,
  `retracted`), rule version, created_at, updated_at. When a correction or re-extraction changes
  an alerted claim (my call): the alert updates in place (new session, speaker, `first_party`) with
  an `alert.updated` SSE event; when the claim no longer passes the rule or is superseded, the alert
  becomes `retracted` and stays visible, struck through, never silently removed. Dedupe across stages and streams of a conference: the same
  announcement repeated later (or on another stage) links to the first alert instead of creating
  a new one; the dedupe is by entity and kind within a time span, with an LLM check only when
  ambiguous (builder's call on the exact method).
- Delivery through a `Notifier` interface. The first one publishes on the conference SSE channel;
  the browser shows a toast and a browser notification (Notification API) when the tab allows it.
  Telegram is a second notifier later.
- Alert latency target: under 90 s from the words being spoken (one extraction interval plus the
  call).
- Alerts from replays and past-video evaluation runs are stored but never notify.

## 6. Frontend

Built on yt-stream's frontend (Next.js, dark, dense, terminal feel).

- **Conference page**: stage tabs or side by side for the two live stages; a global **announcements
  rail** (the alerts, newest first, with session, speaker, kind, importance, quote; click opens the
  audit drawer); unread count.
- **Stage view** (yt-stream's session view, extended): video, a **"now on stage"** bar (session
  title, speakers, confidence, how long, "admin: change"), transcript, claims feed with kind and
  importance, a stage timeline strip (sessions as detected vs as planned, drift visible).
- **Admin**: conferences, stages, schedule (form and bulk paste), start a stream on a stage (live
  URL or past video URL), timeline correction (set session from a time, edit a boundary, mark a
  break), alert rule settings.
- **Evaluation**: yt-stream's replay and compare, plus a per-session view of what was extracted
  and alerted, with thumbs up or down on claims and alerts (section 8).
- Auth: yt-stream's shared-secret login. Admin pages behind the same login for now (single
  operator); a separate admin secret is the builder's call.

## 7. Sources: live and past

Both are YouTube URLs. The speech `HlsSource` path (`yt-dlp -g` then ffmpeg) handles a live stream;
for a past video the operator gives the video URL and the system ingests the whole recording.
A full stage day is 6 to 9 hours, longer than a resolved YouTube media URL lives, so for past
videos download the audio first (`yt-dlp -x`) into the stream's data dir and run it as a file
source; download progress shows on the stream. Speed: `0` (as fast as the GPU allows) by default
for evaluation, `1.0` to simulate live. The download runs on the conf-tracker side into a directory
the shared speech service can read, and the stream starts speech with `file` (my call; this needs
no speech change). Stream-time loops make the model calls the same at any
speed.

Optional (builder's call): a start offset and end offset for past videos, to test on one hour of
a day without running all of it.

## 8. Evaluation loop

The way "important" gets defined. Built in from the start, not bolted on.

1. Pick a past conference, enter its schedule, run one stage day as a past video.
2. Review in the evaluation view: the stage timeline vs what actually happened (the operator
   corrects it in admin; the corrections are the ground truth for the tracker), the alerts and
   claims, marked good, bad or missed. "Missed" is a free-text note with a time.
3. Change the prompt version, rubric, alert rule or tracker settings; replay; compare.
4. Simple numbers per run: tracker agreement with the corrected timeline (share of minutes
   attributed to the right session), alert precision from the thumbs, alert count per hour, cost
   per hour.

Labels live in the database next to the claims they judge and survive replays (a replay's claims
are matched to the original's by time and quote similarity, as the compare page does).

## 9. Infrastructure

The Monash box (RTX A5000, 24 GB) as for yt-stream, the fourth stack on it. New ports so it sits
beside yt-stream, retina and yt-engine (proposed: backend 8094, Postgres 5435, proxy 4003, web
3094; speech is yt-stream's on 8100), a new ngrok endpoint, a new Vercel project. Same auto-deploy pattern, with the
fix noted in yt-stream's PROGRESS (deploy from a marker of the last good commit).

**Where it runs (user's decision).** Nothing live or GPU-bound runs on the dev machine. Build
locally (unit tests, fakes), then deploy to the box, and run and evaluate there, on past videos
first.

**Two parallel stages.** yt-stream's speech process loads Whisper and pyannote once and runs each
session on its own thread, so two streams share one set of models (about 14 GB), and so do any
yt-stream sessions running at the same time. Whether one A5000
keeps two live streams real time, with diarization on both, is unmeasured; it is the first thing
to measure (section 10, phase 0). If it does not, the fallbacks in order: a smaller Whisper model
or `distil-large-v3`, a longer diarization step, batching both streams' chunks. Replays and
past-video runs must yield to live streams (a priority or a cap on concurrent non-live streams).

**LLM load.** All calls go through `claude -p` on one subscription: per live stage about 120
extraction, 60 tracker and up to 60 naming calls an hour, plus re-extractions and dedupe checks.
Subscription rate limits are the risk. Mitigations (my calls): evaluation runs make at most one
model call at a time and pause while a live stream is running; a rate-limited call is stored as
failed and retried with backoff like any `RetryableError`; the status bar shows the proxy's
recent failure rate.

## 10. Build order

Each phase is a branch with an exit checklist in `docs/phases/`, as in yt-stream.

0. **Copy and stand up.** Copy backend, frontend, proxy and deploy; rename; new ports; point at
   yt-stream's speech; strip the Bloomberg prompt; deploy to the box and run one past conference
   video end to end with the existing pipeline. Measure GPU real-time factor with two streams at
   once on the box.
1. **Conferences and schedules.** Tables, admin pages, bulk paste, streams bound to a stage and day.
2. **Session tracker.** Tracker loop, stage timeline, "now on stage" bar, timeline strip, admin
   corrections with claim re-attribution, schedule-aware naming.
3. **Enriched extraction and alerts.** `extract/v3`, kind, importance, entities, the alert rule,
   alerts table, dedupe, announcements rail, browser notifications.
4. **Evaluation.** Past-video download path, labels, per-run numbers, replay and compare with
   sessions; the first tuning pass on one or two past conferences.
5. **Live readiness.** Two live stages in parallel on a real stream, deploy, runbook.

Later: Telegram notifier, schedule scraping, digests.

## 11. Open questions

- Which past conference videos to start evaluating on (chosen when phase 4 starts).
- No target conference date; the build order stands as written.

## 12. Left to the builder

The schedule import format, the alert dedupe method, the exact tracker window and hysteresis
numbers (tuned in phase 4), table and column names, the UI layout details, whether admin gets a
separate secret.
