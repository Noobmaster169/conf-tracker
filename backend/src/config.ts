import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8094),
  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().positive().default(5435),
  PG_DATABASE: z.string().min(1),
  PG_USER: z.string().min(1),
  PG_PASSWORD: z.string().min(1),
  // The speech service's session socket. Tunnelled from the box in development.
  SPEECH_URL: z.string().min(1).default("ws://127.0.0.1:8100/sessions"),
  // The llm-proxy. Host loopback 4003 is where compose.local.yaml publishes it; inside compose it is http://llm-proxy:4000.
  LLM_PROXY_URL: z.url().default("http://127.0.0.1:4003"),
  API_SHARED_SECRET: z.string().min(1),
  // How many live events a session keeps for SSE reconnects before a client must refetch the snapshot.
  SSE_RING_CAPACITY: z.coerce.number().int().positive().default(1000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export type Config = z.infer<typeof Env>;

function load(): Config {
  const parsed = Env.safeParse(process.env);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new Error(`Invalid environment:\n  ${problems.join("\n  ")}`);
}

export const config = load();
