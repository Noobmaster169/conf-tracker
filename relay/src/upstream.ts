/** How the relay talks to the api's event stream: shared by every Channel and every passthrough. */

export function upstreamHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, accept: "text/event-stream", "ngrok-skip-browser-warning": "1" };
}

/**
 * The api's answers no retry will change: wrong secret, or no such video. ngrok answers 404 itself while the box
 * is off the tunnel (ERR_NGROK_3200, endpoint offline), with its own error-code header; that one passes.
 */
export function isPermanent(response: Response): boolean {
  return [401, 403, 404].includes(response.status) && !response.headers.has("ngrok-error-code");
}

/**
 * Reads the body to its end, handing each chunk to `onText`. Returns "stalled" when nothing at all, the api's
 * 15 s pings included, arrived for `stallMs`: a half-open connection that would otherwise sit silent for minutes.
 */
export async function readStream(body: ReadableStream<Uint8Array>, stallMs: number, onText: (text: string) => void): Promise<"done" | "stalled"> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let stalled = false;
  let timer: NodeJS.Timeout | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      void reader.cancel().catch(() => {});
    }, stallMs);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      onText(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return stalled ? "stalled" : "done";
}
