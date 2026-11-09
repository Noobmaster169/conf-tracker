# yt-stream

A live YouTube stream ingestor: the video beside a transcript, speakers and claims,
every one of them auditable. Design: `docs/superpowers/specs/2026-09-23-live-stream-ingestor-design.md`.

Four packages, run from inside each. Never run commands at the root.

| Package | What | Port |
| --- | --- | --- |
| `speech/` | Python. Audio in, transcript events out. Needs the GPU box. | 8100 |
| `backend/` | TypeScript. Sessions, storage, SSE. | 8092 |
| `frontend/` | Next.js. The dashboard. | 3000 |
| `proxy/` | Python. The Anthropic wire in front of claude -p. | 4002 |

## Development

```bash
# speech, on the Monash box (../vps/monash.sh), inside the diarize conda env
cd ~/yt-stream/speech && pip install -e ".[dev]" && python -m speech.server
# on your machine, a tunnel so the backend reaches it as localhost:8100
../vps/monash.sh -N -L 8100:127.0.0.1:8100

# backend: copy the env file, then set the secret in it
cd backend && cp .env.example .env
cd backend && docker compose -f compose.local.yaml up -d && pnpm install && pnpm db:migrate && pnpm dev

# frontend: copy the env file and set the same secret as the backend
cd frontend && cp .env.example .env.local
cd frontend && pnpm install && pnpm dev
```

The compose stack now includes the llm-proxy; set `CLAUDE_CODE_OAUTH_TOKEN` in `backend/.env`
(`claude setup-token`) or every extraction call is stored as failed.

Extraction and naming both use `sonnet` through the same proxy; both are per-session settings (`docs/phases/phase-04-names.md`).

Tests: `pytest` in `speech/`, `pnpm test` in `backend/` (needs the compose Postgres), `pnpm test` in `frontend/`.

Speech needs the pyannote diarization model cached in Hugging Face's local cache; see `speech/README.md`.

Progress and the current phase: `docs/PROGRESS.md`.

Deployment on the Monash box, the public URL and the Vercel settings: `deploy/README.md`.
