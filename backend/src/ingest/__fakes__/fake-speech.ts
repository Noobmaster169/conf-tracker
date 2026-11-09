import type { SpeechEvent, StartMessage } from "../../contracts";
import type { SpeechConnector, SpeechHandlers } from "../speech-client";

export interface FakeSpeech {
  connector: SpeechConnector;
  /** Every start message a session sent. */
  starts: StartMessage[];
  /** Resolves once every scripted event has been handled (and the close, when `closeAfter`). */
  done: Promise<void>;
  /** Resolves once the link was closed from either side. */
  closed: Promise<void>;
  /** Pushes one more event through the handlers, after the script. */
  emit(event: SpeechEvent): Promise<void>;
  /** Simulates the speech side going away. */
  drop(reason: string): Promise<void>;
}

export function fakeSpeech(scripted: SpeechEvent[], options: { closeAfter?: boolean } = {}): FakeSpeech {
  const closeAfter = options.closeAfter ?? true;
  const starts: StartMessage[] = [];
  let handlers: SpeechHandlers | null = null;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  let resolveClosed!: () => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let isClosed = false;

  const close = async (reason: string) => {
    if (isClosed || !handlers) return;
    isClosed = true;
    await handlers.onClose(reason);
    resolveClosed();
  };

  const connector: SpeechConnector = async (start, h) => {
    starts.push(start);
    handlers = h;
    // A throwing handler must fail the test with its cause, not leave `done` pending until a timeout.
    setImmediate(() => {
      void (async () => {
        for (const event of scripted) await h.onEvent(event);
        if (closeAfter) await close("ended");
      })().then(resolveDone, rejectDone);
    });
    return { close: () => void close("close 1000") };
  };

  return {
    connector,
    starts,
    done,
    closed,
    emit: async (event) => {
      if (!handlers) throw new Error("no session connected");
      await handlers.onEvent(event);
    },
    drop: (reason) => close(reason),
  };
}
