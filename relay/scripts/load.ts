/**
 * Opens N viewers on one video through the relay and reports, every 10 s, how many are connected and how many
 * events each has received. Every viewer of a healthy relay sees the same events, so min, median and max agree.
 *
 *   RELAY_SECRET=… node --import tsx scripts/load.ts --url https://relay.fiber.ag --session <id> --n 500 --minutes 10
 *
 * RELAY_SECRET is the relay's own (relay/.env.ship); --after defaults to the newest seq the relay reports.
 */
import { parseArgs } from "node:util";

import { signTicket } from "../src/ticket";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    session: { type: "string" },
    n: { type: "string", default: "100" },
    minutes: { type: "string", default: "5" },
    after: { type: "string" },
  },
});
const secret = process.env.RELAY_SECRET;
if (!values.url || !values.session || !secret) {
  console.error("needs --url, --session and RELAY_SECRET");
  process.exit(1);
}
const url = values.url.replace(/\/+$/, "");
const session = values.session;
const n = Number(values.n);
const until = Date.now() + Number(values.minutes) * 60_000;

async function newestSeq(): Promise<number> {
  const health = (await (await fetch(`${url}/healthz`)).json()) as { channels: { sessionId: string; latest: number }[] };
  return health.channels.find((c) => c.sessionId === session)?.latest ?? 0;
}

const after = values.after !== undefined ? Number(values.after) : await newestSeq();
const ticket = signTicket(session, secret, Math.floor(Date.now() / 1000) + 3600);
const counts = new Array<number>(n).fill(0);
const connected = new Array<boolean>(n).fill(false);
let errors = 0;
const aborts: AbortController[] = [];

async function viewer(i: number): Promise<void> {
  const abort = new AbortController();
  aborts.push(abort);
  try {
    const response = await fetch(`${url}/sessions/${encodeURIComponent(session)}/events?after=${after}&ticket=${ticket}`, { signal: abort.signal });
    if (!response.ok || !response.body) {
      errors++;
      return;
    }
    connected[i] = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      counts[i] += (decoder.decode(value, { stream: true }).match(/^id: /gm) ?? []).length;
    }
  } catch {
    if (!abort.signal.aborted) errors++;
  } finally {
    connected[i] = false;
  }
}

// Ramped, 50 at a time, the way a room opening the page arrives rather than in one instant.
for (let i = 0; i < n; i += 50) {
  for (let j = i; j < Math.min(i + 50, n); j++) void viewer(j);
  await new Promise((r) => setTimeout(r, 500));
}

const report = () => {
  const sorted = [...counts].sort((a, b) => a - b);
  console.log(
    JSON.stringify({ connected: connected.filter(Boolean).length, events: { min: sorted[0], median: sorted[Math.floor(n / 2)], max: sorted.at(-1) }, errors }),
  );
};
const timer = setInterval(report, 10_000);
await new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())));
clearInterval(timer);
report();
aborts.forEach((a) => a.abort());
process.exit(0);
