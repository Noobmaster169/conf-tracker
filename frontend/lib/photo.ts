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
