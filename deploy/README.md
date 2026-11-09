# The box

`student@118.139.133.14`, reached from the dev machine with `../vps/monash.sh '<command>'`.
Its firewall blocks every inbound connection, so the api is published through an
outbound ngrok tunnel and deploys are pulled by cron rather than pushed. This is the
fourth stack on the box, next to yt-engine, retina and yt-stream; nothing here collides with them.

| Piece | How | Listens on |
| --- | --- | --- |
| Postgres 17 | compose service, private network | nothing published |
| api | compose service, built on the box from the clone | `127.0.0.1:8093`, and the tunnel |
| llm-proxy | compose service, built on the box from the clone, Claude Code CLI inside | nothing published, api reaches it as llm-proxy:4000 |
| web | compose service, the dashboard built on the box from the clone | `127.0.0.1:3093`, over an SSH tunnel only |
| speech | **yt-stream's** host process (not part of this stack); its runbook is `~/projects/yt-stream/deploy/README.md` | `172.17.0.1:8100`, the docker bridge only |
| ngrok | `run-ngrok.sh`, standalone `~/bin/ngrok`, its own account and config | outbound only |

Speech is shared: yt-stream's and conf-tracker's sessions run in the same process on the
same loaded models (about 14 GB of the A5000's 24). Restarting it (yt-stream's runbook)
ends every running session of both stacks. Session ids are UUIDs, so the two backends never
collide in speech's `data/` directory.

Directories: `~/projects/conf-tracker` is the git clone (code); `~/conf-tracker` is the
running stack (compose, `.env`, `ngrok.yml`, runner scripts, logs, the `.deployed` marker).

Public URL of the api: `<to fill on first deploy>`.
`GET /health` needs no key; everything else needs `Authorization: Bearer <API_SHARED_SECRET>`.

## Day to day

```bash
../vps/monash.sh 'cd ~/conf-tracker && docker compose ps'          # containers
../vps/monash.sh 'tail -5 ~/conf-tracker/deploy.log'                # what auto-deploy did
../vps/monash.sh 'cat ~/conf-tracker/.deployed'                     # the last commit that deployed cleanly
../vps/monash.sh 'tail -5 ~/yt-stream/speech.log'                   # the shared speech service
../vps/monash.sh 'curl -s 127.0.0.1:8093/health'                    # the api, from the box
../vps/monash.sh 'cd ~/conf-tracker && docker compose exec llm-proxy curl -s 127.0.0.1:4000/healthz'
../vps/monash.sh 'curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:3093/login'  # the dashboard, from the box
```

### The dashboard on the box

The `web` service serves the same dashboard as Vercel, on the box's loopback. Open it through a tunnel from
the dev machine, then browse to `http://localhost:3093`:

```bash
../vps/monash.sh -N -L 3093:127.0.0.1:3093
```

Its password is `ACCESS_PASSWORD` in `~/conf-tracker/.env` (read it with
`../vps/monash.sh 'grep ^ACCESS_PASSWORD ~/conf-tracker/.env'`). The login cookie is marked secure, which browsers
accept on `localhost`, so open it as `localhost`, not by another host name. After changing the password:
`cd ~/conf-tracker && docker compose up -d web`.

### Deploys

A push to `main` reaches the box within three minutes: `auto-deploy.sh` fetches, and when
`origin/main` differs from `~/conf-tracker/.deployed` it rebuilds the api image when `backend/`
changed, the proxy image when `proxy/` changed and the web image when `frontend/` changed. The
marker is written only after the build and `up` succeed, so a failed deploy is logged as
`build failed at <sha>` and retried on the next run. Force a full redeploy with
`../vps/monash.sh 'rm ~/conf-tracker/.deployed'`. The script never writes `.env`, never
touches Postgres data and never touches speech. `bash deploy/test-auto-deploy.sh` tests it
locally with a fake docker.

The stack needs `CLAUDE_CODE_OAUTH_TOKEN` in `~/conf-tracker/.env` or every extraction call is
stored as failed. All model calls go through the `claude -p` subscription.

Reach speech from a dev machine (it binds to the docker bridge, not loopback):

```bash
../vps/monash.sh -N -L 8100:172.17.0.1:8100
```

## First-time setup

1. Create the GitHub repo for conf-tracker and push `main`.
2. Give the box its own read-only deploy key, `~/.ssh/conf-tracker-deploy`, added to the
   repo under Deploy keys, with an SSH alias over 443 because the firewall blocks 22:
   ```
   Host github.com-conf-tracker
       Hostname ssh.github.com
       Port 443
       User git
       IdentityFile ~/.ssh/conf-tracker-deploy
       IdentitiesOnly yes
   ```
   `git clone git@github.com-conf-tracker:<owner>/conf-tracker.git ~/projects/conf-tracker`
3. `mkdir ~/conf-tracker`, copy `deploy/.env.example` to `~/conf-tracker/.env` and fill
   `PG_PASSWORD` and `API_SHARED_SECRET` with `openssl rand -hex 32`, `ACCESS_PASSWORD`
   with any long string, and `CLAUDE_CODE_OAUTH_TOKEN` (make one with `claude setup-token`
   on a logged-in machine). `API_SHARED_SECRET` is also what the frontend sends.
4. ngrok: a new account (each tunnel on the box has its own). The standalone binary in
   `~/bin/ngrok` is already installed for yt-stream (not the snap; see `run-ngrok.sh`). Then
   `~/bin/ngrok config add-authtoken <token> --config ~/conf-tracker/ngrok.yml` and add
   `web_addr: 127.0.0.1:4043` under `agent:` in that file (4040 to 4042 belong to the other
   three tunnels). The static domain is whatever `ngrok http` prints for this account;
   write it into "Public URL" above.
5. Copy `deploy/compose.yaml`, `run-ngrok.sh` and `auto-deploy.sh` into `~/conf-tracker/`,
   `chmod +x` the scripts, then `cd ~/conf-tracker && docker compose up -d --build`. The api's
   CMD runs the migrations before it listens. Then `git -C ~/projects/conf-tracker rev-parse HEAD > ~/conf-tracker/.deployed`.
6. Start ngrok detached, and add it plus the cron line:
   ```
   @reboot NGROK_DOMAIN=<domain> setsid nohup /home/student/conf-tracker/run-ngrok.sh >/dev/null 2>&1 </dev/null &
   */3 * * * * /home/student/conf-tracker/auto-deploy.sh
   ```
7. Smoke: `/health` on the box and through the domain, then one session through the
   domain (`POST /sessions` with the bearer) until a `segment` frame arrives on `/events`.

## The frontend

Vercel, a new project, root directory `frontend`, framework Next.js. Environment variables:
`BACKEND_URL=<the ngrok URL>` and `API_SHARED_SECRET` equal to the box's, and
`ACCESS_PASSWORD`, the dashboard password (unset locks everyone out; changing it signs
everyone out). Nothing is `NEXT_PUBLIC_`. The events proxy route sets `maxDuration = 300`,
the platform's ceiling; the browser reconnects with `Last-Event-ID` when a stream is cut
there, and the backend replays from its ring or sends a snapshot.
