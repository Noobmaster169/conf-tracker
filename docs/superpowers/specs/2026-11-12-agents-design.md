# Agents: a standard, their pages in Admin, and a Watcher

Date: 2026-11-12. Status: design, awaiting approval.

## Why

The conference is days away and after today nobody can log in to the Monash box. The app must be observable and
correctable from outside, by the owner in Admin and by a Claude Code session through the api.

Most of the plumbing for that exists already, but only on a terminal: every model call is stored with its input and
output (`llm_calls`), prompts and settings change at runtime (`/ops/prompts`, `/ops/config`,
`PATCH /sessions/:id/config`), and status, logs, read-only SQL and box jobs are served under `/ops`. Admin shows none
of it. To the owner the four model-driven jobs are a black box: there is no place that says who does what, what each
was given, what it answered, and what it did with the answer.

The owner's picture, in their words: treat every model call as the work of an agent with a persona, like staff in a
company. One works out which session is on, one who is speaking, one pulls claims, one writes summaries. Each can be
opened, read and corrected. Adding one more should follow a plug-and-play standard, "especially for the monitoring".

## Goals

1. **One agent standard in code.** A single definition shape every agent conforms to. Whatever conforms gets its
   Admin page, its call list, its activity record and the Watcher's coverage with no extra work.
2. **Admin shows every agent.** An overview that answers "is anything wrong", and one page per agent with its
   details, every call with input and output, what each call caused, and what was changed about the agent.
3. **Everything on an agent's page can be changed there**, and by one api call: its instructions, its model, its
   thresholds. Applied to running videos as well as new ones. No deploy.
4. **A fifth agent, the Watcher**, that notices trouble and records it as an incident in the database, where the
   owner reads it in Admin. Decided by the owner: no push to a chat.
5. **A Claude Code session can do all of it.** Every read and every fix in Admin is one documented api call, listed
   in `CLAUDE.md`'s ladder and reachable through `ops/ct`.

## Non-goals

- Creating a new agent from a form with no deploy. Decided by the owner: adding an agent stays a code change, but an
  easy one against the standard.
- An agent inside the app that applies fixes on its own. The fixer is a Claude Code session the owner starts.
- Cost reporting. The owner does not care about cost; it stays stored and is shown nowhere prominent.
- Per-caller keys or permissions. One shared key remains.
- Detecting that the box, its cron or the tunnel is down. The Watcher runs inside the api, so it goes down with them
  (see "What this does not cover").

## Anti-goals

- **Rewriting the four live pipelines before the conference.** Tracker, namer, extractor and summarizer keep their
  loops, tables and cursors exactly as they are. This work wraps and describes them; it does not move them.
- **A dense Admin.** The owner rejected a mockup that put everything on one screen and called it unreadable. Show
  the important thing; open the rest on a click.
- A migration that drops, renames or tightens anything (`CLAUDE.md`: additive only, because a rollback puts the old
  image on the new schema).

## Constraints

- Backend changes ship by `git push`; the box holds a backend deploy back while a video runs. Frontend changes build
  on Vercel and touch no video. Prefer putting work in the frontend where either would do.
- `llm_calls.session_id` is `not null`. A model call always belongs to a video. This design keeps that.
- `llm_calls.step` already identifies who made a call (`track`, `name`, `extract`, `summarize`). The agent id is that
  same string, so the 3,575 calls already stored belong to their agents with no backfill.
- The extractor's cursor is "the furthest answered `extract` call" (`calls.lastAnsweredWindow`). Nothing in this
  design may insert an `extract` row that is not a real extraction window.
- Intervals and each agent's on/off switch are fixed when a video starts (`live-config.ts`). That stays; the page
  says which settings wait for the next start.
- `frontend/AGENTS.md` applies: this Next.js version differs from the familiar one; read its bundled docs first.

## The agent standard

One file, `backend/src/agents/agent.ts`, exports the shape; `backend/src/agents/registry.ts` (new, beside the prompt
registry) exports the list of all agents. Roughly:

```ts
export interface AgentDefinition {
  /** Equals llm_calls.step and the prompt directory: "extract". Never changes once calls exist. */
  id: string;
  /** What people call it: "Extractor". */
  name: string;
  /** One line, plain words: "Pulls the claims out of what is said on stage." */
  role: string;
  /** When it runs, as a sentence for the page, and the setting that holds its interval if it has one. */
  trigger: { text: string; intervalKey?: string };
  /** What it is given and what it writes, as short labels for the page. */
  reads: string[];
  writes: string[];
  /** Its settings: the zod object already in contracts.ts (ExtractConfig, ...). Null for an agent with none. */
  settings: z.ZodObject | null;
  /** Which settings name its instructions version and its model, and which only apply at a video's next start. */
  promptKey?: string;
  modelKey?: string;
  fixedAtStart: string[];
  /** The shape of its answer; null for one that answers in free text (the summarizer). */
  output: z.ZodType | null;
  /** Where its settings live: in each video's config, or once for the whole app (the Watcher). */
  settingsScope: "video" | "global";
  /** True for an agent whose calls are about the app, not the video's content: left out of a video's public call feed. */
  internal: boolean;
  /** One line for a call in a list: "3 claims", "Switched to DePIN panel", "Named S2 as Kevin B.". */
  describe(call: LlmCall, effects: CallEffects): string;
}
```

- The four existing agents each get a definition that points at what exists: their config schema, output schema and
  prompt directory. Their run code is not changed.
- `describe` and the effects of a call are computed when read, from the call's stored `parsed` answer and the rows
  that link to it. Verified links today: `claims.call_id` and name proposals (`names.forCall`). For the tracker and
  summarizer the builder derives the line from `parsed` and, where a link exists, the timeline span or summary the
  call produced. No write path of the four changes for this.
- **A run, not a row, is what is counted and shown.** `callStructured` stores each attempt as its own row, so one
  run that fails, is corrected and succeeds is two rows. Lists, the 24-run strip and the Watcher's rules use the last
  attempt of each run (same agent, video and window); the earlier attempt is shown inside the opened call.
- A run is **failed** when its last attempt has an `error`, and **slow** when its `latency_ms` is over that agent's
  threshold. The thresholds are the Watcher's settings and are edited on the Watcher's page only.
- `fixedAtStart` is per agent and comes from the code: the tracker, namer and extractor read their on/off switch and
  interval once at a video's start; the summarizer reads its switch on every call and has no interval.
- The summarizer does not go through `callStructured` and answers in markdown (`summarize.ts`); its definition has
  `output: null` and its stored `parsed` is only the headline.
- **Adding an agent** is then: a definition file, a prompt file `prompts/<id>/v1.md`, its settings schema in
  `contracts.ts`, and its run code calling `callStructured` with its id as the step. A new agent's answer is kept in
  `llm_calls.parsed` like every other; it needs a table of its own only when a public page must query it. This
  checklist goes in `backend/src/agents/README.md` with the Watcher as the worked example.

## The record of activity

One new table, `agent_events` (additive migration):

| column | |
| --- | --- |
| `id` | bigserial |
| `agent_id` | text, the agent it is about |
| `session_id` | uuid, null when not about one video |
| `call_id` | bigint, null when not about one call |
| `kind` | `change` or `rerun` (incidents have their own table, below) |
| `summary` | one plain line |
| `data` | jsonb: before and after for a change, the new answer for a rerun |
| `actor` | text: who did it |
| `created_at` | |

- **Changes.** Every route that alters an agent writes one `change` event: registering or deleting a prompt version,
  `PATCH /ops/config`, `PATCH /sessions/:id/config`, and the new settings route below. One event per agent a patch
  touches, found by which definition owns the key.
- **Who.** There is one shared key, so the caller says who it is in an `x-actor` header (`admin`, `claude-code`,
  anything). Missing means `unknown`. It is a label, not security. (My call.)
- **Effects of calls are not stored here**; they are derived as above, so the four pipelines write nothing new.

An agent's Activity is the merge, newest first, of its calls' one-line results and its events.

## The api (all additive, same bearer key)

| Call | What it does |
| --- | --- |
| `GET /agents` | Every agent: id, name, role, trigger, the versions in use, its last 24 calls as ok/failed/slow, when it last ran, and its open incidents. Enough for the overview with one request. |
| `GET /agents/:id` | The definition in full: reads, writes, settings with each key's default, current value and whether it waits for the next start; instructions versions and which is in use. |
| `GET /agents/:id/calls?session=&status=failed\|slow&before=&limit=` | Its calls, newest first, paged by id, each with its one-line result. No input or output in the list. |
| `GET /calls/:id` | Exists. Gains the agent's one-line result and the events about this call. |
| `GET /agents/:id/activity?before=&limit=` | Calls and events merged. |
| `PATCH /agents/:id/settings` | `{ "set": { "name_floor": 0.6 }, "apply": "all" \| "new" \| "running" }`. Validates against the agent's schema, refuses keys that are not its own, then writes the default config and/or every running video's config through the code that `PATCH /ops/config` and `PATCH /sessions/:id/config` use today. Answers what changed where, and which keys wait for a video's next start. |
| `POST /calls/:id/rerun`, `GET /reruns/:id` | `{ "prompt_version"?, "model"? }`. Starts the run and answers at once with a rerun id; the second route is polled for the new output and whether it parsed. It has to be two steps: Admin's requests time out at 15 s (`frontend/lib/api/transport.ts`) and a model call can take minutes. It stores a `rerun` event (pending, then done or failed) and **nothing in `llm_calls`, claims, names, the timeline or summaries**. (My call: this protects the extractor's cursor and keeps "try it" free of side effects.) |
| `GET /incidents?open=1`, `POST /incidents/:id/resolve` | The Watcher's record. |

What a rerun is, exactly, because a stored call cannot be replayed bit for bit:
- Only the user message is stored. The instructions are rebuilt from the chosen version **as its text stands now**,
  and the window says so. (`PUT /ops/prompts/:step/:version` can overwrite a registered version in place, so an old
  version's text may no longer be what the call saw. Admin never overwrites: "Edit as a new version" always saves
  the next number. The `change` event for an overwrite through the api keeps the text it replaced.)
- A retry row's stored input already holds the model's first answer and the correction. A rerun of it sends the
  run's first attempt's input instead.
- Not offered for the summarizer: its instructions are filled with word limits computed from the transcript, which
  are not stored. Its "run again" is the existing "write the summary again" (`POST /talks/:id/summary`).

In `apply`, **"running"** means every video the runner holds (starting, live, recovering) **and every ended video
with a gap still to fill**: the gap filler runs the tracker, namer and extractor again hours later from that video's
stored config (`gap-filler.ts`), so a fix that skipped them would be undone there.

`GET /watcher` and `PATCH /watcher` are not separate routes: the Watcher's settings go through
`/agents/watch` and `/agents/watch/settings` like any other, and because its `settingsScope` is `global`, `apply` is
ignored.

Instructions keep their existing routes (`GET/PUT/DELETE /ops/prompts/...`); switching the version in use is a
settings patch of the agent's `promptKey`.

## The Watcher

The fifth agent, id `watch`. It runs inside the api on a timer, once a minute, and never while a previous pass is
still running.

**It detects by rules, not by a model.** It must work when the model is down, which is when it is most needed. Each
rule opens an incident; the same condition on the same agent and video updates the open incident (last seen, count)
instead of opening another; an incident closes itself when its condition has been clear for a few passes, or by hand.

| Rule | Condition (defaults, all changeable in its settings) |
| --- | --- |
| An agent keeps failing | 3 failed calls in a row for one agent on one video |
| An agent has gone quiet | A video is live and an enabled agent with an interval has made no call for 5 of its intervals. Not applied to the namer when no voice is unnamed, nor to the summarizer |
| An agent is slow | 3 calls in a row over its slow threshold (default 60 s; summarizer 180 s) |
| A video needs attention | `recovering` for 15 minutes (the condition Admin already shows) |
| A video stopped by itself | It became `degraded` |
| The model proxy or speech does not answer | The probe behind `/ops/status` fails on 2 passes in a row |
| The box stopped reporting | Its report is older than 10 minutes |
| A deploy failed or is held back | As the box's report says |

**It writes a diagnosis with one model call**, for incidents that belong to a video and only when the model answers:
given the incident, the failing calls' errors and the last warnings from the log, it answers what is probably wrong
and which rung of `CLAUDE.md`'s ladder fixes it. That call is an ordinary `watch` call in `llm_calls`, so the Watcher
has calls, input and output on its own page like the others, and is the worked example of the standard. An incident
with no video (proxy down, box silent) gets the rule's own fixed text and no model call.

Its diagnosis calls carry the video's id, so without care they would show in that video's public call feed
(`snapshot.ts`). The snapshot's recent calls and running cost leave out agents marked `internal`. That is the one
existing read this design touches.

What it watches:
- **A cause above explains its symptoms.** While a system incident is open (proxy, speech, box), the per-agent
  incidents it explains are recorded under it and shown folded beneath it, not as separate banners.
- **"Deploy held back" is recorded as a note, not as trouble**: it is the normal state while a video runs. A failed
  deploy is an incident.
- **Replays are not watched.** A video on a hidden stage is, so a test run exercises the Watcher.

**It does not push anywhere.** Decided by the owner: incidents go to the database and are read in Admin. Nothing
leaves the box, so there is no webhook and no secret to hold.

Storage: a new `incidents` table (id, rule, agent_id, session_id, call_id, title, detail, diagnosis, first_seen,
last_seen, count, resolved_at). The Watcher's settings (thresholds, each agent's slow limit)
live under one `settings` key.

## Admin

Look and behaviour follow the mockup the owner approved ("Nice UI"), kept as
`docs/superpowers/specs/2026-11-12-agents-mockup.html` (open it in a browser; its content is sample data): the
existing neutral dark theme, generous space, one line per thing, a status dot, detail on a click. No cost anywhere.
One thing in that file was then changed by the owner: a row must not expand in place. It opens the agent's own page,
and the call list and the input/output window from the mockup live there.

**`/admin/agents`, the overview.** Its only job is "is anything wrong".
- A banner per open incident, at the top, only when there is one. Clicking it opens the incident.
- One row per agent: status dot, name, role, a strip of its last 24 calls (red failed, amber slow), last run.
  Clicking a row goes to that agent's page. It does not expand in place: the owner found a single panel "not
  intuitive" for understanding an agent.
- A quiet line for the system: api, model proxy, speech, box report, deployed commit. Detail on a click.
- "Agents" is added to the Admin area's navigation.

**`/admin/agents/[id]`, one agent.** Sections, in this order, each short by default:
1. **Header**: name, role, status, when it runs, what it reads and writes.
2. **Calls**: the list, newest first, one line each (time, video, result). Filters: video, failed, slow. Clicking a
   call opens a window with the input on the left, the output on the right, the error in plain words on top when
   there is one, what the call caused, and "Run again" (choose a version and model, see the new answer beside the
   stored one).
3. **Activity**: the merged timeline of what it did and what was changed about it, with who and when.
4. **Instructions**: the version in use, the others, where each comes from. Open one to read it. "Edit as a new
   version" opens the text, saves it as the next version, and offers to put it in use for new videos, running ones,
   or both.
5. **Settings**: each key with its current value and default; edit in place; keys that wait for a video's next start
   are marked. Saving asks where to apply.

**The Watcher's page** is the same page; its Calls are its diagnoses and it has one more section, **Incidents**,
open first and then closed, plus its rules' thresholds.

Incidents are shown in the admin area only. The owner said "the monitor page"; the existing `/monitor` is the public
claims feed, open to everyone, so trouble reports do not go there. (My call; the overview at `/admin/agents` is the
monitoring page.)

Every write from Admin goes through server actions that send `x-actor: admin`.

## For Claude Code sessions

- `ops/ct` gains `agents`, `agent ID`, `calls ID [failed]`, `incidents`, and sends `x-actor: claude-code` on writes.
- `CLAUDE.md`'s ladder gains the agent routes and one line: start from `ops/ct incidents` when told something is
  wrong. `README.md` gains the route table.

## What can go wrong, how it shows, and the fix

| Scenario | How it shows | Fix, no deploy |
| --- | --- | --- |
| A wrong name, claim, title, schedule, or session on stage | The public pages; the agent's call that produced it | The correction routes and Admin pages that exist |
| An agent gives bad answers | Its calls, input beside output | Edit its instructions as a new version, run a bad call again to compare, put it in use |
| An agent's answers stop parsing | Incident "keeps failing"; the error on the call | Same; or switch its model in Settings |
| An agent is slow or the model is rate-limited | Incident "slow"; amber in its strip | Switch its model; lengthen its interval for the next video |
| An agent is too eager or too timid | Its calls | Its thresholds in Settings (`name_floor`, `track_switch_confidence`, ...) |
| The model login expired or the proxy is down | Incident; every agent red | `ops/ct job set-env` with a new token; `ops/ct job restart` for the proxy |
| Speech is down | Incident; videos `recovering` | Wait; `speech-restart` only if it stays down (it costs yt-stream's videos too) |
| A video is stuck recovering or stopped | Incident "needs attention" | Leave it, Resume, or Stop, as `CLAUDE.md` says |
| The disk fills | The box report on the overview | `ops/ct job prune`, `recordings-clean` |
| A deploy failed | Incident; the deploy log | Fix forward or revert, and push |
| A container is stuck | The box report | `ops/ct job restart` |

## What this does not cover

Said plainly, because the owner is counting on the box running unattended:

- **If the tunnel, the box, its cron or the api is down, the Watcher is down with it and Admin cannot load its
  incidents either.** With no push, the owner learns of it only by opening Admin and seeing it fail. Catching that
  needs a check that runs somewhere else (the VPS that hosts the relay is the obvious place) and alerts when the
  api stops answering. It is small and worth doing before the conference, but it is a separate piece of work.
- The speech service's code and models belong to yt-stream's stack.
- `API_SHARED_SECRET` and `PG_PASSWORD` cannot be changed from outside.
- There is one model provider. If the Claude login is refused for a reason a new token does not fix, every agent
  stops and nothing here switches provider.

## Order of work

Each step ships by itself and leaves the live pipelines untouched.

1. Agent standard, the four definitions, `GET /agents`, `GET /agents/:id`, the calls list. Backend, additive.
2. Admin overview and agent page, read-only: header, calls, call window. Frontend.
3. The Watcher's rules and incidents; incidents and the banner in Admin. Then its diagnosis call.
4. `agent_events`, the change record on the existing write routes, `x-actor`, Activity. Backend then frontend.
5. `PATCH /agents/:id/settings`, instructions editing and Settings in Admin. Backend then frontend.
6. Rerun.
7. `ops/ct`, `CLAUDE.md`, `README.md`, `backend/src/agents/README.md`.

The order is my call, from what the owner said matters most: seeing calls with their input and output, then knowing
when something goes wrong. Editing comes after because a Claude Code session can already change instructions and
settings through `ops/ct` today; Admin editing is a convenience on top.

Dates: today is 12 November 2026 and the conference is live on 16 November. No stream is running now, so backend
pushes deploy at once until then. Two recorded videos from Solana Accelerate are the test material: every step is
checked by running one of them as a video and reading its agents' pages.

Both new tables go in the first backend push, so later steps need no further migration. Backend steps deploy only
while no video runs, so they go out before the conference's first stream. Nothing here is worth a forced deploy
during a stream: whatever has not shipped by then waits for a gap between videos.

## Left to the builder

- The exact one-line results for the tracker and summarizer, from what their calls store.
- Paging and how many calls the page loads at once.
- The names of React components and how the call window is routed (a modal over the page, with a link that opens it
  directly).
- The Watcher's diagnosis prompt, and its model (default the cheapest that answers fast).
- How the "quiet" rule tells that an agent had nothing to do.
