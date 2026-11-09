/** YouTube's own player at its live edge. Muted so autoplay is allowed; the person unmutes. */
export function VideoEmbed({ videoId }: { videoId: string | null }) {
  if (!videoId) {
    return <div className="flex aspect-video max-h-[40vh] items-center justify-center rounded bg-panel text-ink-dim">no video for a file session</div>;
  }
  return (
    <iframe
      className="mx-auto aspect-video max-h-[40vh] w-full rounded bg-panel"
      src={`https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1`}
      title="live stream"
      allow="autoplay; encrypted-media"
      allowFullScreen
    />
  );
}
