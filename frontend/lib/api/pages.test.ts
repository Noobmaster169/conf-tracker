import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getFeed, getPerson, getTalk, listPeople, listTalks, listVideos } = await import("./pages");
const { PAGE_CACHE_S, FEED_CACHE_S, PUBLIC_TAG } = await import("./transport");

type Seen = { path: string; init: RequestInit & { next?: { revalidate?: number; tags?: string[] } } };
let seen: Seen[] = [];

beforeEach(() => {
  seen = [];
  vi.stubEnv("BACKEND_URL", "https://api.test");
  vi.stubEnv("API_SHARED_SECRET", "s");
  vi.stubGlobal("fetch", async (url: string, init: Seen["init"]) => {
    seen.push({ path: url.replace("https://api.test", ""), init });
    // Every answer fails its schema on purpose: only how it was asked matters here.
    return new Response("null", { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ask = async (read: () => Promise<unknown>): Promise<Seen> => {
  await read().catch(() => null);
  const [last] = seen.slice(-1);
  if (!last) throw new Error("no request made");
  return last;
};

test("the public pages share their data between visitors for a window, tagged so an admin write clears it", async () => {
  for (const read of [() => listVideos(), () => listPeople(), () => listTalks(), () => getTalk("206"), () => getPerson("231")]) {
    const { path, init } = await ask(read);
    expect(init.next, path).toEqual({ revalidate: PAGE_CACHE_S, tags: [PUBLIC_TAG] });
    expect(init.cache, path).toBeUndefined();
  }
});

test("the admin lists and a video page's feed are never stored; the Monitor's feed is shared briefly", async () => {
  for (const read of [() => listVideos(true), () => listPeople(true), () => getFeed("session=abc")]) {
    const { path, init } = await ask(read);
    expect(init.cache, path).toBe("no-store");
    expect(init.next, path).toBeUndefined();
  }
  const monitor = await ask(() => getFeed("", FEED_CACHE_S));
  expect(monitor.init.next).toEqual({ revalidate: FEED_CACHE_S, tags: [PUBLIC_TAG] });
});
