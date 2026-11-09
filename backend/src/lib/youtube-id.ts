const ID = /^[A-Za-z0-9_-]{11}$/;

function valid(candidate: string | null | undefined): string | null {
  return candidate && ID.test(candidate) ? candidate : null;
}

/** The 11-character video id from any YouTube URL shape, or null when it is not one. */
export function videoIdFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, "");
  if (host === "youtu.be") return valid(url.pathname.slice(1));
  if (host !== "youtube.com") return null;
  if (url.pathname === "/watch") return valid(url.searchParams.get("v"));
  const match = url.pathname.match(/^\/(live|embed|shorts)\/([^/]+)/);
  return match ? valid(match[2]) : null;
}
