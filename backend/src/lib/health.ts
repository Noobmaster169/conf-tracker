import { config as env } from "../config";

export type Probe = (url: string) => Promise<{ ok: boolean; detail: string }>;

/** Asks a service's health route, and says what it answered or why it did not. Never throws. */
export const httpProbe: Probe = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return { ok: res.ok, detail: (await res.text()).slice(0, 300) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
};

export const proxyHealthUrl = (): string => `${env.LLM_PROXY_URL.replace(/\/+$/, "")}/healthz`;
export const speechHealthUrl = (): string => env.SPEECH_URL.replace(/^ws/, "http").replace(/\/sessions\/?$/, "/healthz");
