/**
 * Where a browser loads a person's photo from. A photo kept by the backend sits behind its key, so it is read
 * through this app (app/api/photo); a link the admin pasted is used as it is.
 */
export function photoSrc(photoUrl: string | null | undefined): string | null {
  if (!photoUrl) return null;
  const stored = /^\/people\/(\d+)\/photo(\?v=\d+)?$/.exec(photoUrl);
  return stored ? `/api/photo/${stored[1]}${stored[2] ?? ""}` : photoUrl;
}

/** True for a photo the backend keeps, as against a link to somewhere else. */
export const isStoredPhoto = (photoUrl: string | null | undefined): boolean => Boolean(photoUrl?.startsWith("/people/"));

/**
 * How long a photo is kept, by browsers and by Vercel's edge, so the box serves each one once rather than once per
 * visitor. A link with a version (`?v=`, which every upload changes) never goes stale; one without may, so it is kept
 * for minutes. The site is public, so shared caches may hold it.
 */
export function photoCacheControl(url: string): string {
  return new URL(url).searchParams.has("v") ? "public, max-age=31536000, s-maxage=31536000, immutable" : "public, max-age=300, s-maxage=300";
}
