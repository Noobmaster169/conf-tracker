import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ok = (title: string) => new Response(JSON.stringify({ title, author_name: "chan" }), { status: 200 });

describe("videoTitles", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns titles and drops failures", async () => {
    const { videoTitles } = await import("./video-title");
    fetchMock.mockImplementation(async (url) => (String(url).includes("good") ? ok("A") : new Response("", { status: 404 })));
    expect(await videoTitles(["good", "bad", null, "good"])).toEqual({ good: { title: "A", author: "chan" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips a failed id for ten minutes, then asks again", async () => {
    const { videoTitles } = await import("./video-title");
    fetchMock.mockRejectedValue(new Error("timeout"));
    await videoTitles(["x"]);
    await videoTitles(["x"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(10 * 60_000 - 1);
    await videoTitles(["x"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(10 * 60_000);
    fetchMock.mockResolvedValue(ok("B"));
    expect(await videoTitles(["x"])).toEqual({ x: { title: "B", author: "chan" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not remember good lookups as failures", async () => {
    const { videoTitles } = await import("./video-title");
    fetchMock.mockImplementation(async () => ok("C"));
    await videoTitles(["y"]);
    await videoTitles(["y"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
