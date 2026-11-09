# The box

`student@118.139.133.14`, reached from the dev machine with `../vps/monash.sh '<command>'`.
Its firewall blocks every inbound connection, so the api is published through an
outbound ngrok tunnel and deploys are pulled by cron rather than pushed. This is the
third stack on the box, next to yt-engine and retina; nothing here collides with them.

| Piece | How | Listens on |
| --- | --- | --- |
| Postgres 17 | compose service, private network | nothing published |
| api | compose service, built on the box from the clone | `127.0.0.1:8092`, and the tunnel |
| llm-proxy | compose service, built on the box from the clone, Claude Code CLI inside | nothing published, api reaches it as llm-proxy:4000 |
| web | compose service, the dashboard built on the box from the clone | `127.0.0.1:3092`, over an SSH tunnel only |
| speech | host process, diarize conda env, GPU (`run-speech.sh`) | `172.17.0.1:8100`, the docker bridge only |
| ngrok | `run-ngrok.sh`, standalone `~/bin/ngrok`, its own account and config | outbound only |

`run-speech.sh` exports `SPEECH_DIAR_MODEL` and `HF_HUB_OFFLINE=1`; the gated pyannote
model is already in this user's Hugging Face cache, so it loads with no token. `HF_HUB_OFFLINE=1`
also makes faster-whisper load only from the cache, which is fine because `large-v3` is
cached on the box too, but a fresh box needs both models downloaded once (with `HF_TOKEN`
set for the gated one). GPU memory with both models loaded is about 14 GB of 24, pyannote
peaking around 10 GB next to about 4 GB for Whisper.

Directories: `~/projects/yt-stream` is the git clone (code); `~/yt-stream` is the
running stack (compose, `.env`, `ngrok.yml`, runner scripts, `data/`, logs).

Public URL of the api: `https://antiques-hazelnut-footman.ngrok-free.dev`.
`GET /health` needs no key; everything else needs `Authorization: Bearer <API_SHARED_SECRET>`.

## Day to day

```bash
../vps/monash.sh 'cd ~/yt-stream && docker compose ps'          # containers
../vps/monash.sh 'tail -5 ~/yt-stream/deploy.log'                # what auto-deploy did
../vps/monash.sh 'tail -5 ~/yt-stream/speech.log'                # the speech service
../vps/monash.sh 'curl -s 127.0.0.1:8092/health'                 # the api, from the box
curl -s https://antiques-hazelnut-footman.ngrok-free.dev/health  # the api, from anywhere
../vps/monash.sh 'cd ~/yt-stream && docker compose exec llm-proxy curl -s 127.0.0.1:4000/healthz'
../vps/monash.sh 'curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:3092/login'  # the dashboard, from the box
```

### The dashboard on the box

The `web` service serves the same dashboard as Vercel, on the box's loopback. Open it through a tunnel from
the dev machine, then browse to `http://localhost:3092`:

```bash
../vps/monash.sh -N -L 3092:127.0.0.1:3092
```

Its password is `ACCESS_PASSWORD` in `~/yt-stream/.env` (read it with
`../vps/monash.sh 'grep ^ACCESS_PASSWORD ~/yt-stream/.env'`). The login cookie is marked secure, which browsers
accept on `localhost`, so open it as `localhost`, not by another host name. After changing the password:
`cd ~/yt-stream && docker compose up -d web`.

A push to `main` reaches the box within three minutes: `auto-deploy.sh` fetches, and
when the commit changed it rebuilds the api image when `backend/` changed, the proxy image
when `proxy/` changed, the web image when `frontend/` changed, and restarts speech when `speech/` changed. It never writes `.env`
and never touches Postgres data. Since phase 3 the stack also needs `CLAUDE_CODE_OAUTH_TOKEN`
in `~/yt-stream/.env` or every extraction call is stored as failed; see step 7 below.
Since phase 4, until the box's backend has rolled forward, the new frontend's topics panel
shows a 404 error in red. Everything else degrades quietly.

Restart speech by hand (the `[p]` keeps the pattern from matching your own shell; the
runner script starts it again within five seconds):

```bash
../vps/monash.sh 'pkill -f "[p]ython -m speech.server"'
```

Reach speech from a dev machine (it binds to the docker bridge, not loopback):

```bash
../vps/monash.sh -N -L 8100:172.17.0.1:8100
```

## First-time setup (done once, 2026-09-23)

1. The box has its own read-only deploy key, `~/.ssh/yt-stream-deploy`, added to the
   repo under Deploy keys, with an SSH alias over 443 because the firewall blocks 22:
   ```
   Host github.com-yt-stream
       Hostname ssh.github.com
       Port 443
       User git
       IdentityFile ~/.ssh/yt-stream-deploy
       IdentitiesOnly yes
   ```
   `git clone git@github.com-yt-stream:Noobmaster169/yt-stream.git ~/projects/yt-stream`
2. `mkdir ~/yt-stream`, copy `deploy/.env.example` to `~/yt-stream/.env` and fill both
   secrets with `openssl rand -hex 32`. `API_SHARED_SECRET` is also what the frontend sends.
3. ngrok: the official standalone binary in `~/bin/ngrok` (not the snap, whose network AppArmor
   has blocked on this box since 2026-09-30; see `run-ngrok.sh`), then `~/bin/ngrok config add-authtoken <token> --config ~/yt-stream/ngrok.yml`, then add
   `web_addr: 127.0.0.1:4042` under `agent:` in that file (4040 and 4041 belong to the
   other two tunnels). The static domain is whatever `ngrok http` prints for this account.
4. Copy `deploy/compose.yaml` and the three scripts into `~/yt-stream/`, `chmod +x` the
   scripts, then `cd ~/yt-stream && docker compose build api && docker compose up -d`.
   The api's CMD runs the migrations before it listens.
5. Start the two host runners detached, and add them plus the cron line:
   ```
   @reboot setsid nohup /home/student/yt-stream/run-speech.sh >/dev/null 2>&1 </dev/null &
   @reboot setsid nohup /home/student/yt-stream/run-ngrok.sh >/dev/null 2>&1 </dev/null &
   */3 * * * * /home/student/yt-stream/auto-deploy.sh
   ```
6. Smoke: `/health` on the box and through the domain, then one session through the
   domain (`POST /sessions` with the bearer) until a `segment` frame arrives on `/events`.
7. Phase 3: add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `~/yt-stream/.env` (the same kind of
   token retina's stack uses; make one with `claude setup-token` on a logged-in machine),
   then `docker compose build llm-proxy && docker compose up -d`.

## The frontend

Vercel, root directory `frontend`, framework Next.js. Environment variables:
`BACKEND_URL=https://antiques-hazelnut-footman.ngrok-free.dev` and `API_SHARED_SECRET`
equal to the box's, and `ACCESS_PASSWORD`, the dashboard password (unset locks everyone
out; changing it signs everyone out). Nothing is `NEXT_PUBLIC_`. The events proxy route sets
`maxDuration = 300`, the platform's ceiling; the browser reconnects with `Last-Event-ID`
when a stream is cut there, and the backend replays from its ring or sends a snapshot.
