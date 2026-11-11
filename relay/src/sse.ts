import type { RelayEvent } from "./ring";

/**
 * Turns the api's event stream, chunk by chunk, into whole frames. Only frames with a numeric `id:` are events;
 * comments (`: ping`) and anything without an id yield nothing. `raw` is re-joined with "\n", so a CRLF stream
 * reaches browsers in the same shape as an LF one.
 */
export function parseFrames(): (chunk: string) => RelayEvent[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.replaceAll("\r\n", "\n");
    const events: RelayEvent[] = [];
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let seq: number | null = null;
      let type = "message";
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
        else if (line.startsWith("event:")) type = line.slice(6).trim();
      }
      if (seq !== null && Number.isFinite(seq)) events.push({ seq, type, raw: `${block}\n\n` });
    }
    return events;
  };
}
