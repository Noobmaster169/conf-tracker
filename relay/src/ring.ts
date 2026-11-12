/** One event as it arrived from the api: `raw` is the exact SSE frame, so fan-out never re-serialises. */
export interface RelayEvent {
  seq: number;
  type: string;
  raw: string;
}

/**
 * The newest events of one video. It covers every seq after `base`: a viewer whose position is at or after
 * `base` can be caught up from it, one before has missed something the ring no longer holds.
 */
export class Ring {
  #events: RelayEvent[] = [];
  #base: number;

  constructor(
    private readonly capacity: number,
    base: number,
  ) {
    this.#base = base;
  }

  get base(): number {
    return this.#base;
  }

  get latest(): number {
    return this.#events.at(-1)?.seq ?? this.#base;
  }

  push(event: RelayEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.capacity) this.#base = this.#events.shift()!.seq;
  }

  since(after: number): RelayEvent[] | null {
    if (after < this.#base) return null;
    return this.#events.filter((e) => e.seq > after);
  }

  reset(base: number): void {
    this.#events = [];
    this.#base = base;
  }
}
