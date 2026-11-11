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

/** One connection of a scripted speech: its events, or a refusal (the connector throws), or a hold until `gate` resolves. */
export interface ConnectionScript {
  events?: SpeechEvent[];
  /** Close the link after the events, as speech does after `session.ended` (default false: the leg stays open). */
  closeAfter?: boolean;
  /** The connector rejects with this message instead of connecting. */
  refuse?: string;
  /** The connector resolves only once this does (an open still in flight). */
  gate?: Promise<void>;
}

export interface ScriptedConnection {
  start: StartMessage;
  /** Resolves once the scripted events were handled (and the close, when `closeAfter`); at once for a refusal. */
  done: Promise<void>;
  /** Resolves once the link was closed from either side. */
  closed: Promise<void>;
  isClosed(): boolean;
  emit(event: SpeechEvent): Promise<void>;
  drop(reason: string): Promise<void>;
}

export interface ScriptedSpeech {
  connector: SpeechConnector;
  starts: StartMessage[];
  /** Every attempt, refused ones included, in order. */
  connections: ScriptedConnection[];
}

/** A speech service that answers successive connections from a script, one entry each; one past the script fails the test. */
export function scriptedSpeech(scripts: ConnectionScript[]): ScriptedSpeech {
  const starts: StartMessage[] = [];
  const connections: ScriptedConnection[] = [];

  const connector: SpeechConnector = async (start, h) => {
    const script = scripts[connections.length];
    starts.push(start);
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
      if (isClosed) return;
      isClosed = true;
      await h.onClose(reason);
      resolveClosed();
    };
    connections.push({ start, done, closed, isClosed: () => isClosed, emit: (event) => h.onEvent(event), drop: (reason) => close(reason) });
    if (!script) throw new Error(`speech was not scripted for connection ${connections.length}`);
    if (script.refuse !== undefined) {
      isClosed = true;
      resolveDone();
      resolveClosed();
      throw new Error(script.refuse);
    }
    if (script.gate) await script.gate;
    setImmediate(() => {
      void (async () => {
        for (const event of script.events ?? []) await h.onEvent(event);
        if (script.closeAfter) await close("ended");
      })().then(resolveDone, rejectDone);
    });
    return { close: () => void close("close 1000") };
  };

  return { connector, starts, connections };
}
