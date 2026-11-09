# conf-tracker

Live claim extraction for crypto conference stages: each stage's YouTube livestream (or a past
recording of one) beside its transcript, the session on stage, the claims made and an alert
when something important is announced. Design: `docs/superpowers/specs/2026-11-09-conf-tracker-design.md`.

Started from yt-stream at `bdb3240` (`/root/ai/fiber/yt-stream`).

Three packages, run from inside each. Never run commands at the root.

| Package | What | Port |
| --- | --- | --- |
| `backend/` | TypeScript. Sessions, storage, extraction, SSE. | 8093 |
| `frontend/` | Next.js. The dashboard. | 3000 in dev, 3093 on the box |
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

Tests: `pnpm test` in `backend/` (needs the compose Postgres; database `conf_tracker_test`),
`pnpm test` in `frontend/`, `.venv/bin/pytest -q` in `proxy/`, `bash deploy/test-auto-deploy.sh`.

Progress and the current phase: `docs/PROGRESS.md`.

Deployment on the Monash box, the public URL and the Vercel settings: `deploy/README.md`.
