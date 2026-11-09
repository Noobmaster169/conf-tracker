import { proxyLlmClient } from "./agents/llm-client";
import { createApp } from "./app";
import { config } from "./config";
import { closePool, getPool } from "./db";
import { extractorFactory } from "./ingest/extractor";
import { namerFactory } from "./ingest/namer";
import { createSessionRunner } from "./ingest/session-runner";
import { wsSpeechConnector } from "./ingest/speech-client";
import { childLogger } from "./lib/logger";
import { createHub } from "./realtime/hub";
import { markOrphansDegraded } from "./repositories/sessions";

const log = childLogger({ module: "api" });

const db = getPool();
const hub = createHub(config.SSE_RING_CAPACITY);
const llm = proxyLlmClient();
const runner = createSessionRunner({ db, hub, connect: wsSpeechConnector(config.SPEECH_URL), loops: [extractorFactory(llm), namerFactory(llm)] });
const app = createApp({ db, hub, runner });

// This process starts with an empty hub and runner, so no row it inherits as live can still be served.
const orphans = await markOrphansDegraded(db);
if (orphans.length > 0) log.info({ count: orphans.length }, "marked sessions orphaned by a restart as degraded");

const server = app.listen(config.PORT, () => log.info({ port: config.PORT, speech: config.SPEECH_URL, proxy: config.LLM_PROXY_URL }, "api listening"));

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
