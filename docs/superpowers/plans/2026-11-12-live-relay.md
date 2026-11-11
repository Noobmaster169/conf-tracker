# Live Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Viewers' live event streams come from a small relay on the yt-engine VPS, which holds one upstream stream per video, so ngrok and Vercel carry each video's events once instead of once per viewer.

**Architecture:** A new `relay/` package (plain Node `node:http`, no framework) runs as one pod in the VPS's k3s behind the existing ingress-nginx and cert-manager. A viewer's page, rendered on Vercel after the password check, carries a signed ticket; the browser opens its `EventSource` on the relay, which checks the ticket, joins the viewer to that video's channel (one upstream `GET /sessions/:id/events` through ngrok, shared by every viewer), catches them up from a ring, and fans out every event. Anything the relay cannot serve falls back to today's Vercel route.

**Tech Stack:** Node 22 + TypeScript (run with `tsx`, as `backend/` does), vitest, Docker, k3s manifests applied over SSH, Next.js 16 (`frontend/`).

**Spec:** this plan's Design section; the discussion it comes from is the 2026-11-12 session ("relay" and "is the VPS capable").

## Design

```
today:  viewer ─► Vercel fn ─► ngrok ─► box api        (one chain per viewer)

relay:  browser ──(1) page + ticket──► Vercel ─► ngrok ─► box api   (once per page load, as today)
        browser ──(2) EventSource ?ticket──► live.<domain> (ingress-nginx) ─► relay pod
        relay pod ──(3) one upstream per video, Bearer API_SHARED_SECRET──► ngrok ─► box api /sessions/:id/events
        fallback: relay unreachable, 401, 503 or not open within 10 s ─► today's /api/sessions/:id/events on Vercel
```

Channel rules (one channel per session id, created on its first viewer):

- The upstream opens with `?after=<first viewer's after>`. Upstream reconnects (1 s doubling to 30 s) send `?after=<last seq received>`.
- The ring keeps the last `RING_CAPACITY` events and `base`, the highest seq evicted (initially the first `after`). A viewer with `after >= base` is served from the ring; seqs `<= after` are skipped.
- A viewer with `after < base`, or with no `after`, gets a **private passthrough**: its own upstream connection with its own `after`, piped unchanged, exactly today's path. Rare (a phone asleep longer than the ring) and costs what every viewer costs today.
- An upstream `snapshot` event (the api's ring lost the relay's place, e.g. after an api restart) clears the ring, sets `base = snapshot.seq`, and is forwarded to every viewer. The browser already applies `snapshot` events (`frontend/lib/session-state.ts:81`).
- The channel closes its upstream `IDLE_CLOSE_MS` after its last viewer leaves.

Capacity on the VPS (1 vCPU, 1.9 GiB RAM, 382 MiB available, no swap, k3s + yt-engine already running):

| | Per unit | At 2 videos × 500 viewers |
| --- | --- | --- |
| Relay process | about 50 MB | 50 MB |
| Rings | 2,000 events × about 1.5 KB | 6 MB |
| Viewer sockets (Node + nginx) | about 20 KB | 20 MB |
| CPU | about 0.8 events/s per video, one write per viewer | about 800 writes/s, under 5% of a core |
| ingress-nginx connections | 2 per viewer (16,384 per worker) | 2,000 |
| Droplet transfer | about 5 MB per viewer-hour | 2.5 GB/h, about 45 GB for the conference (allowance at least 1 TB) |

Memory is the constraint, and only because the VPS has no swap. Hence a 2 GB swapfile and a 160 Mi pod limit, so the relay can never push yt-engine out of memory.

## Global Constraints

- Nothing under `backend/` changes. No api restart is needed for any task.
- Relay env: `UPSTREAM_URL` (the ngrok URL, `BACKEND_URL` in `frontend/.env.prod`), `API_SHARED_SECRET`, `RELAY_SECRET`, `ALLOWED_ORIGINS` (comma-separated), `PORT=8080`, `RING_CAPACITY=2000`, `IDLE_CLOSE_MS=300000`, `MAX_VIEWERS=1500`, `KEEPALIVE_MS=15000`.
- Every upstream request sends `authorization: Bearer <API_SHARED_SECRET>` and `ngrok-skip-browser-warning: 1`.
- Frontend env (server-only, set on Vercel): `RELAY_URL`, `RELAY_SECRET`. With either unset, the frontend behaves exactly as today.
- Ticket: `"<expS>.<hex HMAC-SHA256(RELAY_SECRET, sessionId + "." + expS)>"`, valid for 12 h (`TICKET_TTL_S = 43200`). It is bound to one session id.
- Never print secrets: the ship script reads them from `frontend/.env.prod` and pipes them into a k8s Secret.
- VPS footprint: namespace `conf-relay` only. Pod resources: requests `cpu: 50m, memory: 64Mi`, limits `cpu: 500m, memory: 160Mi`. yt-engine's namespace is not touched.
- Writes to the VPS (swap, namespace, DNS, image import) and to Vercel env need the user's yes at execution time.
- `frontend/AGENTS.md`: read the Next.js 16 docs in `frontend/node_modules/next/dist/docs/` before touching `frontend/`.

## Review Focus

1. **A viewer reconnecting after the relay restarted** (empty ring, `Last-Event-ID` set): must be served (a new channel opens at that `after`), not stuck. Test in Task 3.
2. **ngrok drops for a minute mid-video:** viewers stay connected, the upstream resumes from its last seq, and no event is duplicated or skipped. Test in Task 2.
3. **The relay is down or unreachable when the page opens:** the browser must be on the Vercel route within 10 s. Test in Task 4.
4. **A ticket for video A used for video B, or expired:** 401, and the browser falls back rather than looping. Test in Tasks 1 and 3.
5. **The upstream answers 404 or 401** (wrong session, wrong secret): the channel ends its viewers' streams instead of reconnecting forever. Test in Task 2.

---

### Task 1: The `relay/` package, tickets and the ring

**Files:**
- Create: `relay/package.json`, `relay/tsconfig.json`, `relay/vitest.config.mts` (copy `backend/`'s shape: `test: vitest run`, `start: node --import tsx src/index.ts`)
- Create: `relay/src/ticket.ts`, `relay/src/ring.ts`
- Test: `relay/test/ticket.test.ts`, `relay/test/ring.test.ts`

**Interfaces:**
- Produces: `verifyTicket(ticket: string, sessionId: string, secret: string, nowS: number): boolean`
- Produces: `signTicket(sessionId: string, secret: string, expS: number): string` (Node `crypto`, used by tests and the load script)
- Produces: `class Ring { constructor(capacity: number, base: number); push(e: RelayEvent): void; since(after: number): RelayEvent[] | null; reset(base: number): void; readonly base: number; readonly latest: number }` where `RelayEvent = { seq: number; type: string; raw: string }` (`raw` is the exact SSE frame, so fan-out never re-serialises)

- [ ] **Step 1: Write the failing tests**

`ticket.test.ts`:
- `signTicket("s1", "k", 2000)` equals the fixed vector `"2000.<hex>"`. Compute it once with `node -e` and paste it in. The same vector goes into the frontend test in Task 4, so both sides provably agree.
- `verifyTicket(t, "s1", "k", 1999)` is true; at `nowS = 2001` false; for `"s2"` false; with secret `"x"` false; for `"garbage"`, `""` and `"2000."` false, without throwing.

`ring.test.ts` (capacity 3, base 10):
- After pushing 11, 12, 13: `since(10)` gives seqs `[11,12,13]`, `since(12)` gives `[13]`, `since(13)` and `since(50)` give `[]`.
- After pushing 14: `base === 11`, `since(10)` is `null`, `since(11)` gives `[12,13,14]`.
- `reset(40)` empties the ring: `since(39)` is `null`, `since(40)` is `[]`.

- [ ] **Step 2: Run `pnpm install && pnpm test` in `relay/`.** Expected: FAIL, modules missing.
- [ ] **Step 3: Implement `relay/src/ticket.ts` and `relay/src/ring.ts`.** Use a constant-time comparison (`timingSafeEqual` on equal-length buffers, as in `backend/src/auth.ts`).
- [ ] **Step 4: Run `pnpm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(relay): tickets bound to one video, and the ring a late viewer catches up from`

### Task 2: One upstream per video

**Files:**
- Create: `relay/src/sse.ts` (incremental SSE frame parser), `relay/src/channel.ts`
- Test: `relay/test/channel.test.ts` (a fake upstream `node:http` server on port 0 that writes frames on command)

**Interfaces:**
- Consumes: `Ring`, `RelayEvent` (Task 1)
- Produces: `parseFrames(): (chunk: string) => RelayEvent[]`. Frames are `id:`/`event:`/`data:` separated by a blank line; comment frames (`: ping`) yield nothing.
- Produces: `class Channel { constructor(opts: { sessionId: string; after: number; upstreamUrl: string; secret: string; ringCapacity: number; idleCloseMs: number; onClosed: () => void; fetchImpl?: typeof fetch }); join(after: number, write: (raw: string) => void, end: () => void): "joined" | "out-of-ring"; leave(write): void; readonly viewers: number; readonly state: "connecting" | "open" | "backoff" | "failed" }`

- [ ] **Step 1: Write the failing tests**
- `fans out once`: two joined viewers each receive frame seq 5 exactly once, and the fake upstream saw exactly **one** request, with `after=4` and both required headers.
- `resumes after a drop`: the upstream destroys its socket after seq 7, and the next upstream request has `after=7`. Seq 8 reaches viewers once, with no duplicate 7.
- `snapshot resets`: upstream sends `snapshot` seq 30. Every viewer receives it, then `join(20, …)` returns `"out-of-ring"` and `join(30, …)` returns `"joined"`.
- `permanent failure`: upstream answers 404, then 401. The channel calls every viewer's `end()`, `state === "failed"`, and no further upstream request is made within 2 s.
- `idle close`: with `idleCloseMs: 50`, the last `leave` closes the upstream connection and calls `onClosed` after 50 ms. A `join` within the 50 ms cancels the close.

- [ ] **Step 2: Run `pnpm test`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement `parseFrames` and `Channel`.** Use `fetch` with an `AbortController` and read `response.body` as text. Backoff starts at 1 s and doubles to 30 s, resetting after a successful open. 401, 403 and 404 are permanent; every other failure retries.
- [ ] **Step 4: Run `pnpm test`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(relay): one upstream stream per video, shared by every viewer`

### Task 3: The relay server

**Files:**
- Create: `relay/src/server.ts`, `relay/src/config.ts` (zod-parsed env, Global Constraints values as defaults), `relay/src/index.ts`
- Test: `relay/test/server.test.ts` (the real server on port 0 against the fake upstream from Task 2)

**Interfaces:**
- Consumes: `verifyTicket` (Task 1), `Channel` (Task 2)
- Produces: `createRelay(config: Config): http.Server`, serving:
  - `GET /sessions/:id/events?ticket=…&after=…` (the `Last-Event-ID` header wins over `after`). Answers with the same SSE headers as `backend/src/routes/events.routes.ts`, plus `access-control-allow-origin: <origin>` when the request's `Origin` is in `ALLOWED_ORIGINS`.
  - `GET /healthz` → `{ ok: true, channels: [{ sessionId, viewers, state, latest }], viewers, passthroughs }`, without auth and without session titles.

- [ ] **Step 1: Write the failing tests**
- A bad, expired or other-video ticket gets 401 JSON, and the upstream sees no request.
- An allowed `Origin` gets the header echoed back. Any other origin gets no `access-control-allow-origin`.
- Two viewers with `after=4` produce one upstream request, and both receive seq 5.
- `out-of-ring` (`Last-Event-ID: 1` when the ring base is 10) opens a passthrough upstream request with `after=1`. That viewer receives what it sends, and `/healthz` shows `passthroughs: 1` until it disconnects.
- After a restart (a new server, empty), a viewer with `Last-Event-ID: 9` opens a channel at `after=9` and is served (Review Focus 1).
- With `MAX_VIEWERS=2`, the third viewer gets 503.
- Each open stream gets `: ping` every `KEEPALIVE_MS` (set to 50 in the test).
- When a viewer disconnects, `/healthz` viewers drops by one.

- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL.
- [ ] **Step 3: Implement `createRelay`, `config` and `index.ts`** (`index.ts` listens on `PORT` and logs one JSON line per channel open and close).
- [ ] **Step 4: Run `pnpm test`.** Expected: PASS.
- [ ] **Step 5: Smoke against prod (a read).** Run `UPSTREAM_URL=… API_SHARED_SECRET=… RELAY_SECRET=dev ALLOWED_ORIGINS=http://localhost:3000 pnpm start`, loading the two secrets from `frontend/.env.prod` without echoing them. Then `curl -N "localhost:8080/sessions/<id of the newest session>/events?ticket=$(node -e …signTicket…)&after=0"`. Expected: frames, or a snapshot then pings.
- [ ] **Step 6: Commit** `feat(relay): the server viewers connect to, with a passthrough for anyone the ring cannot serve`

### Task 4: The frontend uses the relay and falls back to Vercel

**Files:**
- Create: `frontend/lib/relay-ticket.ts` (server-only, Web Crypto, mirrors `frontend/lib/access.ts`)
- Modify: `frontend/app/(app)/video/[id]/page.tsx:25-35` (mint the ticket and pass `relay` to `VideoView`)
- Modify: `frontend/components/video/video-view.tsx:19-20` (accept and forward `relay`)
- Modify: `frontend/components/video/use-session-stream.ts` (relay first, then fallback)
- Test: `frontend/lib/relay-ticket.test.ts`, `frontend/components/video/stream-source.test.ts`

**Interfaces:**
- Produces: `relayTicket(sessionId: string, secret: string, expS: number): Promise<string>`, the same format as Task 1's `signTicket`
- Produces: `relayFor(sessionId: string): Promise<{ url: string; ticket: string } | null>`, which is `null` when `RELAY_URL` or `RELAY_SECRET` is unset
- Produces: `useSessionStream(snapshot: Snapshot, relay: { url: string; ticket: string } | null): SessionState`
- Produces (pure, testable): `streamUrls(sessionId: string, after: number, relay): { primary: string; fallback: string }`

- [ ] **Step 1: Write the failing tests**
- `relayTicket("s1", "k", 2000)` equals Task 1's fixed vector.
- `streamUrls` with a relay gives `primary = <url>/sessions/s1/events?after=4&ticket=…` (encoded) and `fallback = /api/sessions/s1/events?after=4`. Without a relay, both are the Vercel route.
- The fallback rule, as a reducer with fake timers: the source is not open after 10,000 ms, or it reaches `CLOSED` → switch once to fallback, with `after` set to the last seq received. It never switches back within the page's life, so the fallback can't loop.
- [ ] **Step 2: Run `pnpm test` in `frontend/`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Read `node_modules/next/dist/docs/` for server/client prop passing first. Keep the `TYPES` list and parsing exactly as they are, and change only which URL the `EventSource` opens.
- [ ] **Step 4: Run `pnpm test` and `pnpm build` in `frontend/`.** Expected: PASS, and the build succeeds with `RELAY_URL` unset (behaviour identical to today).
- [ ] **Step 5: Commit** (do not push yet; Task 5 deploys the relay first) `feat(ui): live updates from the relay, Vercel's route when it is not there`

### Task 5: Ship the relay to the VPS

**Files:**
- Create: `relay/Dockerfile` (node:22-alpine, `pnpm install --prod`, `CMD node --import tsx src/index.ts`, non-root user)
- Create: `relay/k8s/relay.yaml`: Namespace `conf-relay`; Deployment (1 replica, image `conf-relay:<sha>`, `imagePullPolicy: Never`, Global Constraints resources, `envFrom` Secret `conf-relay-env`, readiness and liveness on `/healthz`); Service; Ingress with `ingressClassName: nginx`, `cert-manager.io/cluster-issuer: letsencrypt-prod`, `nginx.ingress.kubernetes.io/proxy-buffering: "off"`, `proxy-read-timeout: "3600"`, `proxy-send-timeout: "3600"`, host `RELAY_HOST`, TLS secret `conf-relay-tls`
- Create: `relay/ship.sh`: `docker build` → `docker save | ssh (vps/yt-engine.sh) 'k3s ctr images import -'` → create or replace Secret `conf-relay-env` from `frontend/.env.prod` values without printing them (`RELAY_SECRET` is generated once into `relay/.env.ship`, which is gitignored) → `kubectl apply` → `kubectl rollout status`
- Modify: `README.md` (one short section: what the relay is, `relay/ship.sh`, `curl https://<RELAY_HOST>/healthz`)

Steps, each with a yes from the user first:

- [ ] **Step 1: DNS.** The user adds `A <RELAY_HOST> → 168.144.47.194`. Verify with `dig +short <RELAY_HOST>`, which should print `168.144.47.194`.
- [ ] **Step 2: Swap on the VPS.** Run `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`, add it to `/etc/fstab`, and set `vm.swappiness=10`. Verify with `swapon --show`, which should list a 2G swapfile. Check that yt-engine is still `Running`.
- [ ] **Step 3: Run `relay/ship.sh`.** Expected: rollout complete. `curl https://<RELAY_HOST>/healthz` returns `{"ok":true,…}` with a valid certificate, which can take about 1 minute for cert-manager. `kubectl top pod -n conf-relay` shows under 80Mi.
- [ ] **Step 4: Through the real path.** Run `curl -N "https://<RELAY_HOST>/sessions/<newest id>/events?ticket=…&after=0"`. Expected: frames and pings for at least 2 minutes, with no cut at 60 s (proving the ingress timeouts apply).
- [ ] **Step 5: Commit** `feat(relay): ship to the VPS's k3s, behind its ingress and certificates`

### Task 6: Load test, then cut over

**Files:**
- Create: `relay/scripts/load.ts`: opens N concurrent streams (`fetch`, reading the body) for one session id. Every 10 s it prints connected, events received per stream (min/median/max) and errors.

- [ ] **Step 1: Pick the source.** A live or replaying video. Starting a replay is a prod write that spends model calls, so ask first.
- [ ] **Step 2: Run `pnpm tsx scripts/load.ts --session <id> --n 500 --minutes 10` from this machine.** Watch `kubectl top pod -n conf-relay`, `free -m` and yt-engine's pod on the VPS. Pass: all 500 connected, every stream's event count is within 1 of the median, relay memory under 160Mi, yt-engine `Running` with no restarts, and the box's `/healthz` channel count at 1 for that session.
- [ ] **Step 3: Set Vercel env.** Set `RELAY_URL=https://<RELAY_HOST>` and `RELAY_SECRET` (the value from `relay/.env.ship`) for Production, then push the Task 4 commit to `main`. Vercel builds; the box is untouched.
- [ ] **Step 4: Verify in a browser.** On a live video page, the network tab shows the `EventSource` on `<RELAY_HOST>` and live lines arriving. Then scale the relay to 0 (`kubectl scale -n conf-relay deploy/relay --replicas=0`), reload, and the stream should come from `/api/sessions/…/events` within 10 s. Scale back to 1.
- [ ] **Step 5: Record the rollback** in `README.md`: removing `RELAY_URL` on Vercel and redeploying puts every viewer back on today's path.
