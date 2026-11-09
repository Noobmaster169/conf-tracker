# Phase 0: copy and stand up. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** conf-tracker exists as its own repo: yt-stream's backend, frontend, proxy and deploy, renamed and re-ported, pointed at yt-stream's speech service, with a crypto-conference baseline extraction prompt, every test green locally, and a runbook the operator follows to deploy it on the Monash box and measure two streams.

**Architecture:** A one-time import of yt-stream at commit `bdb3240` (via `git archive`, so no history and no untracked files), then mechanical renames, port moves and removals in separate commits. No new behaviour beyond the prompt. Speech is not copied; the backend talks to yt-stream's running speech over the same WebSocket protocol.

**Tech Stack:** as yt-stream: TypeScript, Express, pg, zod, vitest (backend); Next.js 16, Tailwind, SWR (frontend); Python, FastAPI (proxy); Docker compose; pnpm.

**Spec:** `docs/superpowers/specs/2026-11-09-conf-tracker-design.md` (sections 3, 9, 10 phase 0). Background: `/root/ai/fiber/yt-stream/docs/superpowers/specs/2026-09-23-live-stream-ingestor-design.md`.

## Global Constraints

- Source of the copy: `/root/ai/fiber/yt-stream` at commit `bdb3240`, plus that repo's two uncommitted deploy edits (`deploy/README.md`, `deploy/run-ngrok.sh`: the standalone ngrok binary fix).
- Not copied: `speech/`, `docs/`, `.superpowers/`, `.claude/`, any `node_modules`, `.next`, `.env*` other than `.env.example`.
- Names: project `conf-tracker`; Postgres database `conf_tracker` (dev and box), `conf_tracker_test` (tests); docker image prefix `conf-tracker-`.
- Ports: backend 8093, Postgres (local) 5435, proxy (local) 4003, web on the box 3093, ngrok inspection 4043. Speech stays yt-stream's: `ws://127.0.0.1:8100/sessions` in development (SSH tunnel), `ws://host.docker.internal:8100/sessions` on the box.
- Box paths: clone `~/projects/conf-tracker`, stack `~/conf-tracker`.
- yt-stream's engineering rules carry over: zod at every boundary, SQL only in repositories, files under 200 lines, forward-only migrations, no `any`, no emoji, no em dashes.
- Commands run inside a package directory, never at the repo root.

## Review Focus

1. **A leftover `yt-stream` name or port** sends this stack's traffic to yt-stream's (same Postgres port, same compose project name, same image tags on the box). Task 2 ends with a grep that must come back empty apart from the documented provenance lines.
2. **Compose project collision on the box and locally.** Both stacks' compose files must carry distinct `name:` values, or `docker compose up` in one recreates the other's containers. Task 2 checks `docker compose ls` shows both.
3. **auto-deploy treating a failed build as deployed** (yt-stream PROGRESS: the clone fast-forwards before the build). Task 4 makes the marker move only after success, with a scripted check.
4. **The frontend access cookie signed with yt-stream's label** would make a yt-stream cookie valid here when the secrets match. Task 2 changes the HMAC label and its test.
5. **A stored config naming a deleted prompt version** (`extract_prompt: "v2"`) fails at start. The database is fresh, so only the default and the tests matter; Task 3 asserts `v1` and `v2` no longer load.

---

### Task 1: Import yt-stream as the first commit

**Files:**
- Create: everything under `backend/`, `frontend/`, `proxy/`, `deploy/`, plus `.gitignore` and `README.md` at the root, from the archive.
- Keep: `docs/superpowers/specs/2026-11-09-conf-tracker-design.md` and this plan (already present).

- [ ] **Step 1: Initialise the repo**

```bash
cd /root/ai/fiber/conf-tracker && git init -b main
```

- [ ] **Step 2: Extract the archive at `bdb3240` without the excluded paths**

```bash
cd /root/ai/fiber/yt-stream && git archive bdb3240 backend frontend proxy deploy .gitignore README.md | tar -x -C /root/ai/fiber/conf-tracker
cp /root/ai/fiber/yt-stream/deploy/README.md /root/ai/fiber/yt-stream/deploy/run-ngrok.sh /root/ai/fiber/conf-tracker/deploy/
```

Expected: `ls /root/ai/fiber/conf-tracker` shows `backend deploy docs frontend proxy README.md .gitignore`; there is no `speech/`.

- [ ] **Step 3: Commit unchanged, recording provenance**

```bash
cd /root/ai/fiber/conf-tracker && git add -A && git commit -m "chore: import yt-stream backend, frontend, proxy and deploy at bdb3240

Copied from yt-stream bdb3240 via git archive, plus its uncommitted standalone-ngrok fix
in deploy/. speech/ is not copied: conf-tracker uses yt-stream's speech service."
```

---

### Task 2: Rename and re-port

Every occurrence found by `grep -rIn "yt-stream\|yt_stream\|8092\|5434\|4002\|3092\|4042"` outside `docs/`, `node_modules/` and `.next/` changes as below. The list from yt-stream `bdb3240` (re-run the grep; it is the source of truth):

| File | Change |
| --- | --- |
| `backend/package.json`, `frontend/package.json` | `name`: `conf-tracker-backend`, `conf-tracker-frontend` |
| `proxy/pyproject.toml` | `name = "conf-tracker-proxy"`, description says conf-tracker |
| `backend/src/config.ts` | `PORT` default 8093, `PG_PORT` default 5435, `LLM_PROXY_URL` default `http://127.0.0.1:4003` (and its comment) |
| `backend/db/migrate.mjs` | `PG_PORT` fallback `"5435"` |
| `backend/vitest.config.ts` | `PG_PORT` fallback `"5435"`, `PG_DATABASE: "conf_tracker_test"` |
| `backend/compose.local.yaml` | `name: conf-tracker`, Postgres `127.0.0.1:5435:5432`, proxy `127.0.0.1:4003:4000`, comments |
| `backend/.env.example` | `PORT=8093`, `PG_PORT=5435`, `PG_DATABASE=conf_tracker`, `LLM_PROXY_URL=http://127.0.0.1:4003`; `SPEECH_URL` unchanged with a comment: "yt-stream's speech service, tunnelled from the box" |
| `backend/Dockerfile` | `EXPOSE 8093`, `ENV PORT=8093`, comment image name |
| `backend/src/agents/llm-client.ts` | `PROJECT = "conf-tracker"`; update `backend/test/llm-client.test.ts` line with `"x-api-key": "yt-stream"` to `"conf-tracker"` |
| `frontend/.env.example` | `BACKEND_URL=http://127.0.0.1:8093` |
| `frontend/lib/access.ts` | HMAC label `"conf-tracker-access-v1"`; its test still passes (adjust an expected value if the test pins one) |
| `frontend/components/session/use-delay.ts` | key `"conf-tracker:transcript-delay-s"` |
| `frontend/app/layout.tsx` | title `"conf-tracker"`, description `"Live conference claim tracker."` |
| `frontend/app/login/page.tsx`, `frontend/components/nav.tsx`, `frontend/app/claims/page.tsx` | visible name `conf-tracker` |
| `frontend/Dockerfile`, `proxy/Dockerfile` | comment image names |
| `proxy/README.md` | ports 4003, paths `~/conf-tracker/.env` |
| `deploy/compose.yaml` | header comment; `POSTGRES_DB` and `PG_DATABASE` `conf_tracker`; builds `../projects/conf-tracker/{proxy,backend,frontend}`; images `conf-tracker-{llm-proxy,api,web}:local`; api `127.0.0.1:8093:8093`, `PORT: "8093"`, healthcheck on 8093, web `BACKEND_URL: http://api:8093`; web `127.0.0.1:3093:3000`; `SPEECH_URL` stays `ws://host.docker.internal:8100/sessions` with a comment that it is yt-stream's speech |
| `deploy/run-ngrok.sh` | paths `~/conf-tracker/...`, `PORT` default 8093, `web_addr: 127.0.0.1:4043`, "fourth tunnel" in the header |
| `deploy/.env.example` | `~/conf-tracker/.env`; dashboard port 3093 |

`deploy/README.md`, `deploy/auto-deploy.sh` and `deploy/run-speech.sh` are handled in Tasks 4 and 5.

- [ ] **Step 1: Apply the table**

- [ ] **Step 2: Grep for leftovers**

Run: `cd /root/ai/fiber/conf-tracker && grep -rIn "yt-stream\|yt_stream\|8092\|5434\|4002\|3092\|4042" --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=docs . | grep -v "^./deploy/README.md\|^./deploy/auto-deploy.sh\|^./deploy/run-speech.sh\|^./README.md" | grep -vi "speech"`
Expected: no output. (Lines that mention yt-stream's speech service on purpose are filtered by the last `grep`; read them once to confirm each is about speech.)

- [ ] **Step 3: Bring up local infra and run every suite**

```bash
cd backend && cp .env.example .env   # set API_SHARED_SECRET and CLAUDE_CODE_OAUTH_TOKEN
cd backend && docker compose -f compose.local.yaml up -d && pnpm install && pnpm db:migrate && pnpm test && pnpm type-check
cd frontend && pnpm install && pnpm test && pnpm lint && pnpm type-check && pnpm build
cd proxy && pip install -e ".[dev]" && pytest
docker compose ls
```

Expected: all suites pass; `pnpm db:migrate` creates the database `conf_tracker`; the test run uses `conf_tracker_test`; `docker compose ls` lists `conf-tracker` as its own project (beside `yt-stream` if that is up locally).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: rename to conf-tracker and move to ports 8093, 5435, 4003, 3093"
```

---

### Task 3: Crypto-conference baseline extraction prompt

Replaces the Bloomberg prompts. Same output schema (`claim`, `topics`, `polarity`, `quote`) so no code beyond the default changes; the schedule-aware prompt with `kind` and `importance` is phase 3.

**Files:**
- Create: `backend/src/agents/prompts/extract/v3.md`
- Delete: `backend/src/agents/prompts/extract/v1.md`, `backend/src/agents/prompts/extract/v2.md`
- Modify: `backend/src/contracts.ts:220` (`extract_prompt` default `"v3"`)
- Test: `backend/test/registry.test.ts`, `backend/test/extract.test.ts`, `backend/test/contracts.test.ts`

**Interfaces:**
- Produces: prompt `extract/v3`, frontmatter `step: extract`, `version: v3`, `model: sonnet`; still contains `{{schema}}`. Phase 3 adds `v4`.

- [ ] **Step 1: Update the tests first**

In `registry.test.ts` replace the "extract v2 is the latest" test:

```ts
test("extract v3 is the only extract prompt and is about conference talks", () => {
  expect(listVersions("extract")).toEqual(["v3"]);
  expect(latestVersion("extract")).toBe("v3");
  const prompt = loadPrompt("extract", "v3");
  expect(prompt).toMatchObject({ step: "extract", version: "v3", model: "sonnet" });
  expect(prompt.text).toContain("{{schema}}");
  expect(prompt.text).toContain("[mm:ss S3 Jane Doe]");
  expect(prompt.text.toLowerCase()).toContain("conference");
  expect(() => loadPrompt("extract", "v2")).toThrow();
});
```

Change `loadPrompt("extract", "v1")` to `"v3"` in `registry.test.ts:10-14` and `extract.test.ts:18` (and `prompt_version: "v3"` at `extract.test.ts:35`); `contracts.test.ts:48` expects `extract_prompt: "v3"`.

- [ ] **Step 2: Run and see them fail**

Run: `cd backend && pnpm vitest run test/registry.test.ts test/extract.test.ts test/contracts.test.ts`
Expected: FAIL, no `v3`.

- [ ] **Step 3: Write `extract/v3.md` and change the default**

Keep v2's structure (the transcript format paragraph, the `quote` rules verbatim, "new lines" vs "context", "already extracted", empty list is a good answer, the schema footer). Replace the subject:

- Opening: "You watch a live stream of a crypto conference stage (talks, panels, firesides, keynotes) with a rolling transcript..."
- A claim: an announcement (a launch, release, date, partnership, funding, listing), a new number (users, volume, TVL, revenue, throughput), a roadmap item, or a speaker's view or prediction about a project, a token, a chain, the market or the industry, specific enough to be checked or disagreed with. Examples: "Firedancer will reach mainnet by the end of Q1", "the protocol now settles 40 million transactions a day", "we are partnering with Visa on stablecoin settlement", "restaking yields will compress below 3 percent this year".
- Not a claim: MC hand-offs and introductions, thanks, housekeeping (wifi, the next session, the venue), sponsor reads, questions, jokes, and vague enthusiasm ("this is an exciting time for the ecosystem").
- `topics`: examples `solana`, `ethereum`, `stablecoins`, `defi`, `restaking`, `firedancer`, `payments`, `ai`, `regulation`; a project's common name.
- `polarity`: bullish or bearish for the project, token or sector the claim is about; neutral for a fact or date with no direction; none when it is not about a project, token or market.

Set `extract_prompt` default to `"v3"` in `contracts.ts`; delete v1 and v2.

- [ ] **Step 4: Run the whole backend suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(backend): extract v3, a crypto conference baseline, replaces the Bloomberg prompts"
```

---

### Task 4: auto-deploy moves a marker only after a successful deploy

yt-stream PROGRESS: the clone fast-forwards before the build, so a failed build is never retried. Here the script compares `origin/main` with `$STACK/.deployed` (the last commit that deployed cleanly) and writes it only at the end.

**Files:**
- Modify: `deploy/auto-deploy.sh`
- Delete: `deploy/run-speech.sh`
- Create: `deploy/test-auto-deploy.sh`

- [ ] **Step 1: Write `deploy/test-auto-deploy.sh`**

A bash script that builds a throwaway origin repo and clone in `mktemp -d`, puts a fake `docker` first on `PATH` (exits 0, or 1 when `FAIL_BUILD=1`), and runs `auto-deploy.sh` with `CLONE` and `STACK` pointed at the temp dirs. Assertions, each printing `ok` or `FAIL` and the script exiting non-zero on any `FAIL`:

1. First run with a backend change: `.deployed` equals origin/main's sha; `deploy.log` has `rebuilt and restarted: api`.
2. A second run with no new commit: exits 0, log unchanged.
3. A new backend commit with `FAIL_BUILD=1`: `.deployed` still holds the old sha; the log has `build failed`.
4. The same commit rerun with `FAIL_BUILD=0`: rebuilds and `.deployed` moves to the new sha.

- [ ] **Step 2: Run it and see it fail**

Run: `bash deploy/test-auto-deploy.sh`
Expected: FAIL at assertion 1 (no `.deployed` is written today).

- [ ] **Step 3: Change `auto-deploy.sh`**

- Defaults `CLONE=$HOME/projects/conf-tracker`, `STACK=$HOME/conf-tracker`; header comment updated; no speech section (speech belongs to yt-stream) and `run-speech.sh` out of the copy list.
- `deployed=$(cat "$STACK/.deployed" 2>/dev/null || echo none)`; exit 0 when it equals `origin/main`.
- Fast-forward the clone as today; diff for changed services from `$deployed` to `$after` (all three services when `deployed` is `none`).
- A failed `docker compose build` or `up` logs `build failed at <sha>` and exits 1 without writing the marker.
- On success write the sha to `$STACK/.deployed.new` and `mv` it into place.

Delete `deploy/run-speech.sh`.

- [ ] **Step 4: Run the test**

Run: `bash deploy/test-auto-deploy.sh`
Expected: four `ok` lines, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(deploy): auto-deploy retries a failed build by deploying from a marker of the last good commit; speech is yt-stream's"
```

---

### Task 5: Docs and the phase 0 runbook

**Files:**
- Modify: `README.md`, `deploy/README.md`
- Create: `docs/PROGRESS.md`, `docs/phases/phase-00-copy-and-stand-up.md`

- [ ] **Step 1: `README.md`**

Three packages (backend 8093, frontend 3000 in dev, proxy 4003) plus "speech: yt-stream's service on the Monash box, port 8100, reached over `../vps/monash.sh -N -L 8100:172.17.0.1:8100`". Development commands as yt-stream's README with the new ports. Links to the spec, `docs/PROGRESS.md` and `deploy/README.md`. One provenance line: "Started from yt-stream at `bdb3240`."

- [ ] **Step 2: `deploy/README.md`**

yt-stream's runbook with: paths and ports from the Global Constraints; the speech row says "yt-stream's host process (not part of this stack); restart and logs per yt-stream's runbook"; the speech restart and `run-speech.sh` sections removed; the auto-deploy section describes the `.deployed` marker and how to force a redeploy (`rm ~/conf-tracker/.deployed`); "fourth stack on the box, next to yt-engine, retina and yt-stream"; the public ngrok URL left as `<to fill on first deploy>`.

First-time setup steps in order: create the GitHub repo and push `main`; deploy key and `git clone` into `~/projects/conf-tracker`; `~/conf-tracker/.env` from `deploy/.env.example` (`PG_PASSWORD`, `API_SHARED_SECRET`, `ACCESS_PASSWORD`, `CLAUDE_CODE_OAUTH_TOKEN`); ngrok config with `web_addr: 127.0.0.1:4043`; copy the compose file and scripts; crontab for `auto-deploy.sh` and `run-ngrok.sh`; first `docker compose up -d --build`; Vercel project with `BACKEND_URL` = the ngrok URL, `API_SHARED_SECRET`, `ACCESS_PASSWORD`.

- [ ] **Step 3: `docs/phases/phase-00-copy-and-stand-up.md`**

The exit checklist. Local items (done by this plan): the five commits above, all suites green. Box items (done by the operator later, unchecked here):

1. Stack up on the box, `/health` answers over the ngrok URL, the dashboard loads on Vercel.
2. One past conference stage video (a full recorded stage stream) started as a session by URL; transcript, speakers and claims arrive; it stops cleanly. Record the video, its length, claim count and cost in this file.
3. Two-stream measurement: start two replays of that session at `speed` 1.0 at the same time (paced like live), with yt-stream idle, and watch `health` for 15 minutes. Pass when `lag_s` and `buffer_s` stay flat for both (no growth). Record GPU memory (`nvidia-smi`), `gpu_ms_asr`, `gpu_ms_diar`. If it fails, record the numbers and stop: the spec's fallbacks (section 9) become phase 0b.
4. A yt-stream session still starts and runs while conf-tracker is up (shared speech, no interference).

- [ ] **Step 4: `docs/PROGRESS.md`**

Phases 0 to 5 from the spec's section 10, phase 0 current ("local done, box items pending"). A Deferred section carrying over the yt-stream PROGRESS items that still apply (SSE stays open after stop, the negative `lag_s`, claims not re-attributed on speaker relabel, topic near-duplicates, cache-read tokens not counted, a quote's time is its line's start) and one new item: the `HlsSource` reads a past video's URL as fast as ffmpeg delivers and the resolved URL can expire on a 6 to 9 hour video; phase 4 downloads first.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: README, deploy runbook, progress and the phase 0 checklist for conf-tracker"
```
