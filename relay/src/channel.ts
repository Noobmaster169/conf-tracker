import { Ring, type RelayEvent } from "./ring";
import { parseFrames } from "./sse";
import { isPermanent, readStream, upstreamHeaders } from "./upstream";

export interface ChannelOptions {
  sessionId: string;
  /** Where the upstream starts: the first viewer's position. */
  after: number;
  upstreamUrl: string;
  secret: string;
  ringCapacity: number;
  idleCloseMs: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Silence (no event, no ping) after which the upstream is treated as dead and reconnected. */
  upstreamStallMs?: number;
  /** Called once when the channel ends on its own (idle, or the api refused it for good). */
  onClosed: () => void;
  fetchImpl?: typeof fetch;
}

type Write = (raw: string) => void;
interface Viewer {
  end: () => void;
  /** The newest seq this viewer has. */
  pos: number;
}

/**
 * One video's stream from the api, shared by every viewer of it. Holds a single upstream connection, resumes it
 * from the last seq after any drop, and catches a late viewer up from its ring.
 */
export class Channel {
  readonly #opts: Required<Omit<ChannelOptions, "fetchImpl">> & { fetchImpl: typeof fetch };
  readonly #ring: Ring;
  readonly #viewers = new Map<Write, Viewer>();
  #abort: AbortController | null = null;
  #retry: NodeJS.Timeout | null = null;
  #idle: NodeJS.Timeout | null = null;
  #backoff: number;
  /** After the api's seq space went backwards (it restarted), the old seqs up to here mean nothing any more. */
  #regressedAbove = -1;
  #state: "connecting" | "open" | "backoff" | "failed" | "closed" = "connecting";

  constructor(opts: ChannelOptions) {
    this.#opts = { minBackoffMs: 1000, maxBackoffMs: 30_000, upstreamStallMs: 45_000, fetchImpl: fetch, ...opts };
    this.#ring = new Ring(opts.ringCapacity, opts.after);
    this.#backoff = this.#opts.minBackoffMs;
    void this.#connect();
  }

  get state(): "connecting" | "open" | "backoff" | "failed" | "closed" {
    return this.#state;
  }

  get viewers(): number {
    return this.#viewers.size;
  }

  get latest(): number {
    return this.#ring.latest;
  }

  join(after: number, write: Write, end: () => void): "joined" | "out-of-ring" {
    // A position past the ring but within the old seq space comes from before an api restart: the passthrough
    // gets that viewer the api's snapshot. Past the ring otherwise is a page a moment ahead of us, and joins.
    if (after > this.#ring.latest && after <= this.#regressedAbove) return "out-of-ring";
    const backlog = this.#ring.since(after);
    if (backlog === null) return "out-of-ring";
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    backlog.forEach((e) => write(e.raw));
    this.#viewers.set(write, { end, pos: Math.max(after, backlog.at(-1)?.seq ?? after) });
    return "joined";
  }

  leave(write: Write): void {
    this.#viewers.delete(write);
    if (this.#viewers.size === 0 && !this.#idle && this.#state !== "failed" && this.#state !== "closed") {
      this.#idle = setTimeout(() => this.#finish("closed"), this.#opts.idleCloseMs);
    }
  }

  /** Stops everything without telling the owner; the owner calling this already knows. */
  close(): void {
    this.#state = "closed";
    this.#stop();
  }

  #stop(): void {
    this.#abort?.abort();
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#idle) clearTimeout(this.#idle);
    this.#retry = this.#idle = null;
  }

  #finish(state: "failed" | "closed"): void {
    if (this.#state === "closed" || this.#state === "failed") return;
    this.#state = state;
    this.#stop();
    for (const viewer of this.#viewers.values()) viewer.end();
    this.#viewers.clear();
    this.#opts.onClosed();
  }

  #deliver(event: RelayEvent): void {
    if (event.type === "snapshot") {
      // The api lost our place (its ring moved on, or it restarted): everything before this is gone.
      if (event.seq < this.#ring.latest) this.#regressedAbove = Math.max(this.#regressedAbove, this.#ring.latest);
      this.#ring.reset(event.seq);
      for (const [write, viewer] of this.#viewers) {
        write(event.raw);
        viewer.pos = event.seq;
      }
      return;
    }
    if (event.seq <= this.#ring.latest) return;
    this.#ring.push(event);
    for (const [write, viewer] of this.#viewers) {
      if (event.seq <= viewer.pos) continue;
      write(event.raw);
      viewer.pos = event.seq;
    }
  }

  #ended(): boolean {
    return this.#state === "closed" || this.#state === "failed";
  }

  async #connect(): Promise<void> {
    if (this.#ended()) return;
    this.#state = "connecting";
    const abort = new AbortController();
    this.#abort = abort;
    const { upstreamUrl, sessionId, secret } = this.#opts;
    const url = `${upstreamUrl.replace(/\/+$/, "")}/sessions/${encodeURIComponent(sessionId)}/events?after=${this.#ring.latest}`;
    // The watchdog in readStream starts with the body; this one covers an answer that never comes at all.
    let timedOut = false;
    const connectTimer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.#opts.upstreamStallMs);
    try {
      const response = await this.#opts.fetchImpl(url, {
        headers: upstreamHeaders(secret),
        signal: abort.signal,
      }).finally(() => clearTimeout(connectTimer));
      if (isPermanent(response)) {
        await response.body?.cancel().catch(() => {});
        this.#finish("failed");
        return;
      }
      if (!response.ok || !response.body) throw new Error(`upstream answered ${response.status}`);
      this.#state = "open";
      this.#backoff = this.#opts.minBackoffMs;
      const parse = parseFrames();
      await readStream(response.body, this.#opts.upstreamStallMs, (text) => parse(text).forEach((event) => this.#deliver(event)));
    } catch {
      // A drop, a refused connection or an abort: the retry below decides which. A stall ends the read
      // without an abort, so it retries like a drop.
    }
    if ((abort.signal.aborted && !timedOut) || this.#ended()) return;
    this.#state = "backoff";
    this.#retry = setTimeout(() => void this.#connect(), this.#backoff);
    this.#backoff = Math.min(this.#backoff * 2, this.#opts.maxBackoffMs);
  }
}
