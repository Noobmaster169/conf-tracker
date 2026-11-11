import { proxyLlmClient } from "./agents/llm-client";
import { createApp } from "./app";
import { config } from "./config";
import { closePool, getPool } from "./db";
import { extractorFactory } from "./ingest/extractor";
import { namerFactory } from "./ingest/namer";
import { createSessionRunner } from "./ingest/session-runner";
import { createSweeper } from "./ingest/sweeper";
import { createSummarizer } from "./ingest/summarizer";
import { trackerFactory } from "./ingest/tracker";
import { wsSpeechConnector } from "./ingest/speech-client";
import { childLogger } from "./lib/logger";
import { fetchVideoTitle } from "./lib/video-title";
import { createHub } from "./realtime/hub";
import { setOverrides } from "./agents/prompts/registry";
import * as promptOverrides from "./repositories/prompt-overrides";

const log = childLogger({ module: "api" });

const db = getPool();
// Prompt versions registered through the api outlive a restart: they are read back before any video can start.
setOverrides(await promptOverrides.list(db));
const hub = createHub(config.SSE_RING_CAPACITY);
const llm = proxyLlmClient();
const summarize = createSummarizer({ db, llm });
const runner = createSessionRunner({
  db,
  hub,
  connect: wsSpeechConnector(config.SPEECH_URL),
  loops: [trackerFactory(llm, summarize), extractorFactory(llm), namerFactory(llm)],
});
const app = createApp({ db, hub, runner, summarize, fetchTitle: fetchVideoTitle });

const server = app.listen(config.PORT, () => log.info({ port: config.PORT, speech: config.SPEECH_URL, proxy: config.LLM_PROXY_URL }, "api listening"));
// Videos a previous process left running are fed again from the second they stopped. Not awaited: listening comes first.
runner
  .resumeAll()
  .then((ids) => log.info({ count: ids.length }, "resumed videos a restart left running"))
  .catch((error) => log.error({ err: error instanceof Error ? error.message : String(error) }, "resuming videos a restart left running failed"));

// What a stopped video still owes (windows a downed model left, summaries that failed) is finished in the background.
const sweeper = createSweeper({ db, hub, llm, summarize, runner });
const sweep = () => void sweeper.sweep().then((r) => (r.extracted.length || r.summarised.length) && log.info(r, "sweep finished work"));
sweep();
setInterval(sweep, 5 * 60 * 1000).unref();

async function shutdown(): Promise<void> {
  try {
    server.close();
    await closePool();
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, "shutdown failed");
  }
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
