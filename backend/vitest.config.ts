import { defineConfig } from "vitest/config";

// The tests talk to the compose Postgres, in a database of their own, so they
// never see or touch development rows. global-setup.ts refuses any other name.
export const TEST_ENV = {
  NODE_ENV: "test",
  PG_HOST: "127.0.0.1",
  // Another local stack may hold 5435, so a run can point elsewhere.
  PG_PORT: process.env.TEST_PG_PORT ?? "5435",
  PG_DATABASE: "conf_tracker_test",
  PG_USER: "postgres",
  PG_PASSWORD: "localdev",
  SPEECH_URL: "ws://127.0.0.1:1/sessions",
  LLM_PROXY_URL: "http://127.0.0.1:1",
  API_SHARED_SECRET: "test-key",
  LOG_LEVEL: "silent",
};

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: TEST_ENV,
    fileParallelism: false,
  },
});
