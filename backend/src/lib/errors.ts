/** Worth another attempt: a timeout, a 5xx, a dependency that is restarting. */
export class RetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableError";
  }
}

/** Will fail the same way every time: bad input, a 404, a schema that does not parse. */
export class TerminalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalError";
  }
}

/**
 * A dependency answered, or refused to, and the answer was a failure. `status` is
 * what the api relays; `retryable` is the dependency's own verdict where it gave one.
 */
export class UpstreamError extends Error {
  readonly status: number;
  readonly retryable: boolean | null;

  constructor(status: number, message: string, options?: { cause?: unknown; retryable?: boolean | null }) {
    super(message, { cause: options?.cause });
    this.name = "UpstreamError";
    this.status = status;
    this.retryable = options?.retryable ?? null;
  }
}

export function isTransient(error: UpstreamError): boolean {
  return error.retryable ?? (error.status === 429 || error.status >= 500);
}
