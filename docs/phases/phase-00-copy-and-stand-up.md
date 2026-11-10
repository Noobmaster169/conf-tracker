# Phase 0: copy and stand up

Plan: `docs/superpowers/plans/2026-11-09-phase-00-copy-and-stand-up.md`.
Spec: `docs/superpowers/specs/2026-11-09-conf-tracker-design.md`, sections 3, 9 and 10.

## Local (done on branch `phase-00-copy-and-stand-up`)

- [x] yt-stream `bdb3240` imported (backend, frontend, proxy, deploy; no speech, no history).
- [x] Renamed to conf-tracker; ports 8094, 5435, 4003, 3094; database `conf_tracker`; compose project `conf-tracker`.
- [x] `extract/v3`, a crypto conference baseline prompt, replaces the Bloomberg prompts.
- [x] `auto-deploy.sh` deploys from a `.deployed` marker and retries a failed build; `run-speech.sh` removed.
- [x] Suites green: backend 171, frontend 95, proxy 148, `deploy/test-auto-deploy.sh`.

## On the box (operator, not done yet)

1. [ ] Stack up per `deploy/README.md` first-time setup; `/health` answers over the ngrok URL;
   the dashboard loads on Vercel.
2. [ ] One past conference stage video (a full recorded stage stream) started as a session by
   URL; transcript, speakers and claims arrive; it stops cleanly. Record here: the video, its
   length, the claim count and the cost.
3. [ ] Two-stream measurement. With yt-stream idle, start two replays of that session at
   `speed` 1.0 at the same time (paced like live: `POST /sessions/:id/replay` with
   `{"speed": 1}`, twice) and watch `health` for 15 minutes. Pass when `lag_s` and `buffer_s`
   stay flat for both (no growth). Record GPU memory (`nvidia-smi`), `gpu_ms_asr` and
   `gpu_ms_diar`. If it fails, record the numbers and stop: the spec's fallbacks (section 9)
   become phase 0b.
4. [ ] A yt-stream session still starts and runs while conf-tracker is up (shared speech, no
   interference).

## Results

(fill in from the box items above)
