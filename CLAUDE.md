# Working on conf-tracker

The live stack runs on a university box nobody can log in to during the conference. **Assume there is no SSH.**
Everything is done through two doors, and both work from any machine:

- **The api**, over its public URL, with `ops/ct` (reads `frontend/.env.prod`; never print its values).
- **`git push` to `main`**: the box pulls it within three minutes (`deploy/auto-deploy.sh`), Vercel builds the frontend.

Start every piece of live work with `ops/ct status` and `ops/ct incidents`. The first says what commit is running,
whether a video is live, whether the model proxy and speech answer, how many model calls failed in the last hour, and
what the box last reported. The second is what the Watcher found wrong, each with what it thinks the cause and the
fix are.

## The agents

Every model call is the work of an agent: the Tracker (`track`, which session is on stage), the Namer (`name`, who
each voice is), the Extractor (`extract`, the claims), the Summarizer (`summarize`, a session's write-up) and the
Watcher (`watch`, which looks at the others once a minute and records incidents). Admin › Agents shows each one;
the same is on a terminal:

- `ops/ct agents`: every agent in a line, with its last 24 runs (`.` ok, `X` failed, `s` slow).
- `ops/ct agent extract`: its settings and instructions. `ops/ct calls extract failed`: its failed runs.
- `ops/ct get /calls/ID`: one call with its input, its output and every attempt.
- `ops/ct post /calls/ID/rerun '{"prompt_version":"v6"}'`, then `ops/ct get /reruns/N`: the same input sent again,
  to judge a change before making it. It stores nothing but a note that it was tried.

Every write says who made it (`ops/ct` sends `x-actor: claude-code`), and an agent's Activity lists it.

## The ladder: use the lowest rung that fixes it

| The problem | The fix | Restarts anything? |
| --- | --- | --- |
| A wrong name, claim, title, schedule, what is on stage | The correction routes in `README.md` (`ops/ct put/patch/delete ...`), or the Admin pages | No |
| An agent gives bad answers | Read them first: `ops/ct calls extract failed`, `ops/ct get /calls/ID`. Then `ops/ct prompt-put extract v6 file.md`, try it on a bad call (`ops/ct post /calls/ID/rerun '{"prompt_version":"v6"}'`), and put it in use: `ops/ct patch /agents/extract/settings '{"set":{"extract_prompt":"v6"},"apply":"all"}'`. Or all of it on the agent's page in Admin | No. A running video uses it at its next run |
| A threshold or model (`name_floor`, `track_switch_confidence`, `extract_model`, ...) | `ops/ct patch /agents/name/settings '{"set":{"name_floor":0.6},"apply":"all"}'`. `apply` is `all`, `new` (videos started later) or `running` (the ones running now, and ended ones still filling a gap). `ops/ct agent name` lists every key and its default; a null value takes a key back to its default | No. An interval or an on/off switch waits for a video's next start, and the answer says so |
| The Watcher raises too much or too little | Its thresholds are its settings: `ops/ct agent watch`, `ops/ct patch /agents/watch/settings '{"set":{"fail_runs":5}}'`. `"enabled": false` stops it | No |
| Something looks wrong and you do not know why | `ops/ct logs 200 warn`, `ops/ct sql "select ..."`, `ops/ct get /calls/ID`, `ops/ct box` | No |
| The dashboard (anything under `frontend/`) | Commit, push | No video is touched |
| Backend code (anything under `backend/`) | Commit, push, `ops/ct wait-deploy` | **Yes: an api restart costs each running video a short catch-up.** So the box holds the deploy back while one runs and ships it when none does |
| A container is stuck, a token expired, the disk is full | `ops/ct verbs`, then `ops/ct job ...` | Depends on the verb; it says |
| Anything else on the box | A one-shot script, `deploy/ops.d/README.md` | Whatever the script does |

A prompt registered through the api lives in the database. Also commit it as
`backend/src/agents/prompts/<step>/vN.md` so the repo stays the record; the registered copy wins while both exist, and
`ops/ct delete /ops/prompts/<step>/vN` hands it back to the file.

## What a restart costs

A video's transcript, voices and timeline are fed by one long connection from the api to speech. When the api or speech
restarts, that connection drops and the api opens it again from the second it stopped, on the **same** video, catching
up through YouTube's rewind (on a stream with rewind; on one without, the missed stretch is filled from the recording after the stream ends). The admin page shows the video as `recovering` meanwhile. So during a conference day:

- A backend deploy still costs every running video a short catch-up, so the box holds it back while one runs. Do not
  force it (`ops/ct job deploy-now`, or `[deploy-now]` in the commit message) unless the bug is worth that. Say so to
  the user first.
- Prefer the runtime rungs above. They exist so that a live day needs no restart.
- `speech-restart` costs the videos of this stack **and of yt-stream**, which shares the service, a catch-up.
- A `degraded` or `stopped` video can be resumed: `ops/ct post /sessions/ID/resume`, or Resume in Admin.
- The model proxy can restart mid-video: calls fail for some seconds and the next run picks up where it was.

## "Needs attention"

A video that has been `recovering` for 15 minutes also shows "Needs attention" with the last error. It is still
retrying (every minute at most); nothing is lost that the stream's rewind or its recording can give back.

- **Usually: leave it.** It keeps retrying and comes back by itself once speech or YouTube answers again. Check the
  cause with `ops/ct status` and `ops/ct logs 200 warn`.
- **After the stream ended**, it fills itself: once YouTube serves the recording (minutes to hours later), the next
  retry reads what it missed from there and the video ends normally.
- **Stop** (Admin, or `ops/ct post /sessions/ID/stop`) records the stretch it missed, from where it stopped reading to
  now, as a gap, filled from the recording after the stream. Without a known stream clock (a recording, or a leg that
  never started) it records nothing and says so on the video; Resume reads it instead.
- Common errors: `speech unreachable` (speech down or restarting: `ops/ct status`; `speech-restart` only if it stays
  down, and it ends yt-stream's videos too); `yt-dlp failed` / `no audio` (YouTube refused or the stream is off: wait,
  or check the link); `speech service too old to resume (update yt-stream speech)` (speech ignored where to start; it
  does **not** retry: update yt-stream's speech, then Stop and Resume).

## Shipping code

1. Tests first: `pnpm test` in `backend/` (needs `docker compose -f compose.local.yaml up -d postgres`), `pnpm test`
   in `frontend/`, `bash deploy/test-auto-deploy.sh` when `deploy/` changed.
2. Commit and push to `main`. This network blocks GitHub's SSH port, so `origin` is HTTPS with the `gh` login.
3. `ops/ct wait-deploy`. It ends with one of: deployed; held back (a video is running); failed (the box kept, or put
   back, what was running, and `ops/ct status` shows the deploy log).
4. A deploy that failed is not retried until `main` moves. Fix forward or `git revert`, and push.

Migrations are additive only. A rollback puts the previous image back on top of the new schema, so a migration that
drops or renames something the old code reads turns a rollback into an outage.

`deploy/auto-deploy.sh` is the lifeline: if it breaks, nothing can reach the box again. Change it only when you must,
keep it small, and run `bash deploy/test-auto-deploy.sh` before pushing. `deploy/box-ops.py` is deliberately separate
and cannot stop a deploy.

## What cannot be fixed from outside

Say these plainly to the user instead of trying:

- The Watcher runs inside the api. When the tunnel, the box or the api is down, it is down too and records nothing,
  and Admin cannot load to show it. Nothing here notices that from outside.
- The tunnel (ngrok) down or over its plan's limits: the api is unreachable, so `ops/ct` is blind. `git push` still
  deploys, and a one-shot script still runs, but nothing reports back.
- The box off, its cron gone, or its network down: `ops/ct status` shows the box report going stale (the api itself
  may still answer for a while, or not).
- `API_SHARED_SECRET` and `PG_PASSWORD` in the box's `.env`: deliberately not changeable through the api.
- The speech service's code and models: they belong to yt-stream's stack.

## Conventions

- A scheduled session is a `talk`; a video is a `session`. Three packages (`backend/`, `frontend/`, `proxy/`); run
  commands inside each, never at the root. `frontend/AGENTS.md` applies to the Next.js code.
- "The tests" or "the runs" in the user's words means the runs live in prod, not the local database.
- Reads of prod are free. Before a write that deletes, restarts or ends something, say what it does and get a yes.
