# Frames: a gallery of what was on stage

## Why

The app is text: transcripts, claims, summaries. Pictures of the stage make it something people want to look at, and
the same pictures feed what we post later (summaries, tweets, maybe a claim's card). The user's words: "the most
important thing is just having image resources that can be used for display".

Called **frames** in code and **Gallery** in the UI ("snapshot" already means a video's state in `routes/snapshot.ts`).

## Goals

- A gallery per session (talk) and per video, filling while the video runs, readable after.
- Cover the slide deck: each slide about once. A slide shown for under ~20 s may be missed.
- Few near-repeats: the same speaker shot, the same slide with the speaker moving beside it, a crossfade between slides.
- Known repeating screens (the "ACCELERATE APAC" wide shot, break cards) at most once per video, and never in a break.
- Images kept with their stream time and video, so a later feature can embed the frame at a claim's or a summary's time.

## Non-goals

- No model call per frame: the quota is live's. Dedupe is code.
- No manual curation UI now (the user: blurry frames are not a concern). The api can hide a frame; that is all.
- No frames for the stretch a live video missed while recovering (could be filled from the recording later).

## Anti-goals

- Image bytes through ngrok or the VPS relay. The box uploads to Cloudflare R2; browsers read R2's public URL; the
  api and SSE carry only keys and URLs.
- A frames failure touching a video. The framer runs beside the session runner, never inside it; a failed grab is a log
  line.

## Constraints found

- The api never reads video today; speech (yt-stream) reads audio only. Frames need their own yt-dlp + ffmpeg in the
  api image, run with `--remote-components ejs:github --js-runtimes node` like speech.
- On a **live** stream, ffmpeg reads the HLS manifest yt-dlp resolves: resolve 2.5 s, one 720p frame 3.5 s, ~165 KB.
- On a **recording**, YouTube refuses ffmpeg's own range reads (403 past the first bytes); yt-dlp piping the whole video
  into ffmpeg works and is fast: a 9.3 h 720p video downloaded and keyframe-decoded in 7 min on the box.
- R2: bucket `fiber`, public at `R2_PUBLIC_URL`; credentials in the box's `.env` (`R2_*`), passed to the api by compose.

## How it works

**Grab.** Every `interval_s` (10) of wall clock, for each live video with a YouTube source: one frame at the live edge
(the manifest is cached for 30 min and resolved again on a failure). Its stream time is `now - broadcast_start` when the
broadcast clock is known, else the newest transcript time. A recording (or an ended live stream) is filled on request,
`POST /sessions/:id/frames/fill`: the whole video, a keyframe every `interval_s`.

**Signature.** Each grab is scaled to 64x36 grey with area averaging (each value is the mean of a 20x20 block of the
720p frame). Kept with the frame (2304 bytes), with a motion mask (which cells moved between the grab and the next one).

**Keep or drop** (measured on 90 minutes of day 1: 527 distinct grabs -> ~95 kept, almost every slide, distinct speakers):
1. *Settle*: a grab is a candidate; it is judged only when the next grab is close to it (under `settle_frac` of cells
   differ by more than 6). A crossfade never settles.
2. *Same as a kept frame of this video* when both: under `coarse_frac` (0.4) of cells differ by more than
   `coarse_delta` (12), and, over the cells that moved in neither (the speaker beside a slide moves; the slide does not),
   under `fine_frac` (0.07) differ by more than `fine_delta` (6). Same -> dropped.
3. *A blocked screen*: same as a frame hidden with `block` in any video -> dropped.
4. *In a break*: the Tracker's span at that time is a break -> dropped at read (spans arrive later than frames, and a
   corrected span re-sorts frames, as it does claims).

**Store.** Kept: a 1280 px WebP (~80 KB) and a 480 px thumbnail at `frames/<session>/<t>.webp` and `..._thumb.webp`,
uploaded with `cache-control: public, max-age=31536000, immutable`; then a `frames` row. A frame belongs to the talk
whose span covers its time, decided at read.

**Read.** `GET /sessions/:id/frames`, `GET /talks/:id/frames` (frames not hidden, not in a break, oldest first, each with
`url` and `thumb_url`). `PATCH /frames/:id {"hidden":true,"block":true}`. Settings `GET/PATCH /ops/frames` (stored under
the `frames` key; `enabled`, `interval_s` and the thresholds; changes apply at the next grab).

**Show.** A Gallery tab on a session's page, a grid of thumbnails opening the full image; a strip on the video page.

## Left to the builder

Names of files and functions; how per-video state is held; log wording; the exact layout of the gallery grid.
