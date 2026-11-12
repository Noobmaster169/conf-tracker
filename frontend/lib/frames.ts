import { formatT } from "./format";

/**
 * A frame image the download route may fetch: only a frame on an R2 public bucket, so the route is no open proxy.
 * R2 serves the images from another origin, where a browser ignores `download`; the route hands the same bytes over
 * from this origin as a file.
 */
export function isFrameUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.endsWith(".r2.dev") && /^\/frames\/[0-9a-f-]{36}\/\d+(\.\d+)?\.webp$/.test(url.pathname) && url.search === "";
  } catch {
    return false;
  }
}

/** A file name for a frame: the session's title and the time in it, e.g. `fireside-chat-anatoly-yakovenko-12-04.webp`. */
export function frameFileName(title: string, t: number): string {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 60)
      .replace(/-+$/, "") || "frame";
  return `${slug}-${formatT(t).replace(/:/g, "-")}.webp`;
}

export const frameDownloadUrl = (url: string, name: string): string => `/api/frame?u=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`;

/** Up to n frames spread evenly over the list, the first always among them. */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!);
}
