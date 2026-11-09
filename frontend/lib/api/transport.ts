// Holds the bearer secret path, so a client component importing this must fail the build.
import "server-only";

import type { z } from "zod";

/**
 * How the frontend reaches the backend, and nothing about what it asks for.
 * Server-side only: the shared secret must never reach the browser, so nothing
 * under components/ may import this. Pages, route handlers and server actions do.
 */
function config(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.BACKEND_URL;
  const secret = process.env.API_SHARED_SECRET;
  if (!baseUrl) throw new Error("BACKEND_URL is not set");
  if (!secret) throw new Error("API_SHARED_SECRET is not set");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), secret };
}

export async function request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { baseUrl, secret } = config();
  const { timeoutMs = 15_000, headers, signal, ...rest } = init;
  return fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      // A free ngrok tunnel answers an HTML interstitial to what looks like a browser; this turns it off.
      "ngrok-skip-browser-warning": "1",
      ...(headers as Record<string, string> | undefined),
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
}

/** Every response goes through this: a drifted field fails here, named, not in a component as undefined. */
export async function parseAs<T>(schema: z.ZodType<T>, response: Response, what: string): Promise<T> {
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${what} answered outside the contract at ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return parsed.data;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export async function refusalMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const message = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof message === "string" ? message : `Backend returned ${response.status}`;
}

export async function get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
  const response = await request(path);
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(schema, response, `GET ${path}`);
}
