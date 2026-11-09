/** The last `capacity` events of one session, so a reconnecting client can catch up without a snapshot. */
export interface Ring<T extends { seq: number }> {
  push(item: T): void;
  /**
   * Everything after `seq`; [] when `seq` is the last one issued; null when `seq` has
   * fallen out of the ring or was never issued (a restart reset the count), so the
   * client must resync.
   */
  since(seq: number): T[] | null;
  lastSeq(): number;
}

export function createRing<T extends { seq: number }>(capacity: number): Ring<T> {
  const items: T[] = [];
  let last = 0;
  return {
    push(item) {
      items.push(item);
      last = item.seq;
      if (items.length > capacity) items.shift();
    },
    lastSeq: () => last,
    since(seq) {
      if (seq === last) return [];
      if (seq > last) return null;
      const oldest = items[0];
      if (!oldest || seq < oldest.seq - 1) return null;
      return items.filter((item) => item.seq > seq);
    },
  };
}
