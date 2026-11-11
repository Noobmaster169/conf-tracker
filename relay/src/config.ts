import { z } from "zod";

const schema = z.object({
  /** The api's public URL (the ngrok tunnel). */
  UPSTREAM_URL: z.url(),
  API_SHARED_SECRET: z.string().min(1),
  /** Shared with the Vercel frontend, which signs the tickets. */
  RELAY_SECRET: z.string().min(16),
  ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  PORT: z.coerce.number().int().min(0).default(8080),
  RING_CAPACITY: z.coerce.number().int().positive().default(2000),
  IDLE_CLOSE_MS: z.coerce.number().int().positive().default(300_000),
  MAX_VIEWERS: z.coerce.number().int().positive().default(1500),
  KEEPALIVE_MS: z.coerce.number().int().positive().default(15_000),
});

export type Config = z.output<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
