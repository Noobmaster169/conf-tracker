/**
 * Plays a scripted stage through the real pipeline, for a dev machine that cannot reach the speech service.
 *
 *   pnpm simulate                 # scripts/demo-stage.json
 *   pnpm simulate path/to.json
 *   pnpm simulate --scripted      # no model: the answers written in the script file (scripts/scripted-llm.ts)
 *
 * It writes what speech would have (segments with speaker labels) and runs the tracker, the namer and the extractor
 * on stream time against the real llm-proxy, then ends the video so the summaries are written. Nothing is faked
 * after the transcript: the timeline, the names, the claims and the summaries are what the prompts produce.
 * It only adds rows, and refuses to run in production.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { proxyLlmClient } from "../src/agents/llm-client";
import { ExtractConfig, NameConfig, StageBody, TrackConfig } from "../src/contracts";
import { closePool, getPool } from "../src/db";
import { createExtractor } from "../src/ingest/extractor";
import { createNamer } from "../src/ingest/namer";
import { createSummarizer } from "../src/ingest/summarizer";
import { createTracker } from "../src/ingest/tracker";
import { parseSchedule } from "../src/pipeline/schedule-text";
import { createHub } from "../src/realtime/hub";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as speakers from "../src/repositories/speakers";
import * as stages from "../src/repositories/stages";
import * as talks from "../src/repositories/talks";
import { Scripted, scriptedLlm } from "./scripted-llm";

const Script = z.object({
  video_url: z.url(),
  video_title: z.string(),
  stage: StageBody,
  schedule: z.string(),
  lines: z.array(z.tuple([z.number(), z.string(), z.string()])).min(1),
  scripted: Scripted.optional(),
});

if (process.env.NODE_ENV === "production") throw new Error("the simulator does not run in production");

const args = process.argv.slice(2);
const useScripted = args.includes("--scripted");
const path = args.find((arg) => !arg.startsWith("--")) ?? join(dirname(fileURLToPath(import.meta.url)), "demo-stage.json");
const script = Script.parse(JSON.parse(readFileSync(path, "utf8")));
const db = getPool();
const hub = createHub(10);

const stage = await stages.create(db, script.stage);
const parsed = parseSchedule(script.schedule);
if (parsed.errors.length > 0) throw new Error(parsed.errors.join("; "));
for (const talk of parsed.talks) await talks.create(db, stage.id, talk);
if (useScripted && !script.scripted) throw new Error(`${path} has no "scripted" answers`);
const llm = useScripted ? scriptedLlm(script.scripted!, await talks.forStage(db, stage.id)) : proxyLlmClient();
const created = await sessions.create(db, { sourceUrl: script.video_url, sourceFile: null, config: {}, stageId: stage.id, title: useScripted ? `${script.video_title}, scripted answers` : script.video_title });
const sessionId = created.id;
await sessions.markStarted(db, sessionId, { startedAt: new Date(Date.now() - script.lines.at(-1)![0] * 1000).toISOString(), models: { asr: "simulated" } });
console.log(`video ${sessionId} on stage ${stage.id}`);

const tracker = createTracker({ db, hub, sessionId, llm, config: TrackConfig.parse({}), summarize: createSummarizer({ db, llm }) });
const namer = createNamer({ db, hub, sessionId, llm, config: NameConfig.parse({}) });
const extractor = createExtractor({ db, hub, sessionId, llm, config: ExtractConfig.parse({}) });
hub.subscribe(sessionId, (event) => {
  if (event.type === "call") console.log(`  ${event.data.step} ${Math.round(event.data.window_t1)}s ${event.data.error ?? `ok ${(event.data.latency_ms / 1000).toFixed(1)}s`}`);
  if (event.type === "span") console.log(`  on stage: ${event.data.state} talk=${event.data.talk_id} from ${event.data.t0} to ${event.data.t1 ?? "now"}`);
  if (event.type === "claims.new") for (const claim of event.data) console.log(`  claim [${claim.status} ${claim.kind} ${claim.importance}] ${claim.claim}`);
  if (event.type === "speaker" && event.data.name) console.log(`  ${event.data.speaker_id} is ${event.data.name} (person ${event.data.person_id})`);
});

const STEP_S = 30;
let boundary = STEP_S;
const seen = new Map<string, { first: number; talk: number }>();
for (const [i, [t0, speaker, text]] of script.lines.entries()) {
  // A line lasts until the next one starts, less a breath; its words are spread evenly over it.
  const t1 = Math.min(t0 + 20, (script.lines[i + 1]?.[0] ?? t0 + 12) - 0.5);
  while (t0 >= boundary) {
    // Live order on one clock: the tracker and the namer read first, so the extractor sees what they decided.
    if (boundary % 60 === 0) {
      await tracker.tick(boundary);
      await namer.tick(boundary);
    }
    await extractor.tick(boundary);
    boundary += STEP_S;
  }
  const words = text.split(" ");
  const step = (t1 - t0) / words.length;
  await segments.insert(db, sessionId, { t0, t1, text, words: words.map((w, j) => ({ w, t0: t0 + j * step, t1: t0 + (j + 1) * step, p: 1, speaker_id: speaker })) });
  const known = seen.get(speaker) ?? { first: t0, talk: 0 };
  seen.set(speaker, { first: known.first, talk: known.talk + (t1 - t0) });
  await speakers.upsert(db, sessionId, { speakerId: speaker, firstSeenT: known.first, lastSeenT: t1, talkS: known.talk + (t1 - t0) });
}
await tracker.tick();
await namer.tick();
await extractor.flush();
await sessions.setStatus(db, sessionId, "stopped");
console.log("video ended; writing summaries");
await tracker.flush();
await closePool();
console.log(`done: /video/${sessionId}`);
