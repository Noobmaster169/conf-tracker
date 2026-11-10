/** YouTube's own player. Muted so autoplay is allowed; the person unmutes. A new `start` reloads it at that second. */
export function Player({ videoId, start }: { videoId: string | null; start: number | null }) {
  if (!videoId) return <div className="flex aspect-video items-center justify-center rounded-xl bg-sunk text-ink-soft">This video has no player.</div>;
  const at = start === null ? "" : `&start=${Math.max(0, Math.floor(start))}`;
  return (
    <iframe
      key={start ?? "live"}
      className="aspect-video w-full rounded-xl bg-ink"
      src={`https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1${at}`}
      title="Video"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
    />
  );
}
