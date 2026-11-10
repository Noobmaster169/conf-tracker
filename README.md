# conf-tracker

Live claim extraction for crypto conference stages: each stage's YouTube livestream (or a past
recording of one) beside its transcript, the session on stage, the claims made and an alert
when something important is announced. Design: `docs/superpowers/specs/2026-11-09-conf-tracker-design.md`.

## The app

| Page | What it is |
| --- | --- |
| Videos (`/`) | Every stream tracked, as cards. A video's page has the player, the session on stage, the live transcript and its claims. |
| Monitor (`/monitor`) | The newest claims from every stage and who made them. Refreshes itself. |
| Sessions (`/sessions`) | Each stage's schedule. A session that has finished opens to a written summary and its claims. |
| Speakers (`/speakers`) | Everyone heard or scheduled. A speaker's page lists everything they have claimed. |
| Admin (`/admin`) | Stages and their schedules, starting a video on a stage, correcting what is on stage, speaker profiles. |

How it fits together: the admin creates a **stage** (one stage of one conference on one day) and pastes its
schedule. A **video** is bound to a stage. While it runs, a tracker reads the last minutes of transcript against the
schedule every minute and keeps a timeline of which session is on stage; extraction and speaker naming are told what
the schedule says; a named voice is linked to a **person**; a claim belongs to the session whose stretch of the
timeline covers it; and a session that leaves the stage gets its summary.

In the code a scheduled session is a `talk` and a video is a `session` (the table yt-stream started with), so the two
never share a word. Prompts: `backend/src/agents/prompts/{track,extract,name,summarize}`. The summary prompt is yt-engine's, adapted for a conference session.

## Putting data right through the API

Everything stored can be read and corrected with the bearer key, so nothing needs the database or the box
(`backend/src/routes/corrections.routes.ts`, next to the admin area's routes for stages, schedules and people). Every
delete is for good.

| Call | What it does |
| --- | --- |
| `PUT /sessions/:id/speakers/:sid` | Says who a voice is. Body is exactly one of `{ "name": "Jane Doe", "org": "...", "title": "..." }` (the person is found or made), `{ "person_id": 12 }`, `{ "name": null }` (takes the name off) or `{ "merge_into": "S4" }` (the voice is really that one). Every claim and line of the voice follows. A name given this way is never replaced by the namer. |
| `PATCH /claims/:id` | Changes any of `claim`, `kind`, `importance`, `topics`, `polarity`, `speaker_id` (null for no speaker). The quote and its time stay. |
| `DELETE /claims/:id` | Removes a claim. |
| `PATCH /sessions/:id` | `{ "title": "..." }`, the name on the video's card. |
| `DELETE /sessions/:id` | Removes a video with its transcript, voices, claims, timeline, summaries and model calls. Refused (409) while it runs or has replays. The recording kept by the speech service stays on the box. |
| `DELETE /stages/:id` | Removes a stage and its schedule. Refused (400) while a video is on it or still holds a stretch of its timeline; hide it instead (`PUT /stages/:id`). People stay. |

Started from yt-stream at `bdb3240` (`/root/ai/fiber/yt-stream`).

Three packages, run from inside each. Never run commands at the root.

| Package | What | Port |
| --- | --- | --- |
| `backend/` | TypeScript. Sessions, storage, extraction, SSE. | 8094 |
| `frontend/` | Next.js. The dashboard. | 3000 in dev, 3094 on the box |
| `proxy/` | Python. The Anthropic wire in front of `claude -p`. | 4003 locally |
| speech | yt-stream's service on the Monash box, shared with that stack. Not in this repo. | 8100 |

## Development

Nothing live or GPU-bound runs on the dev machine: build and unit-test here, then deploy and
run on the box (`deploy/README.md`).

```bash
# a tunnel to yt-stream's speech service, so the backend reaches it as localhost:8100
../vps/monash.sh -N -L 8100:172.17.0.1:8100

# backend: copy the env file, then set the secret in it
cd backend && cp .env.example .env
cd backend && docker compose -f compose.local.yaml up -d && pnpm install && pnpm db:migrate && pnpm dev

# frontend: copy the env file and set the same secret as the backend
cd frontend && cp .env.example .env.local
cd frontend && pnpm install && pnpm dev
```

Local compose runs Postgres on 5435 and the llm-proxy on 4003; set `CLAUDE_CODE_OAUTH_TOKEN` in
`backend/.env` (`claude setup-token`) or every extraction call is stored as failed.

No speech service and no model on a dev machine? `cd backend && pnpm simulate --scripted` plays a made-up two-session
conference (`scripts/demo-stage.json`) through the real tracker, namer, extractor and summarizer with answers written
in the file, so every page has something to show. `pnpm simulate` without the flag does the same against the real
llm-proxy, which is the quickest way to judge the prompts.

Tests: `pnpm test` in `backend/` (needs the compose Postgres; database `conf_tracker_test`),
`pnpm test` in `frontend/`, `.venv/bin/pytest -q` in `proxy/`, `bash deploy/test-auto-deploy.sh`.

Progress and the current phase: `docs/PROGRESS.md`.

Deployment on the Monash box, the public URL and the Vercel settings: `deploy/README.md`.
