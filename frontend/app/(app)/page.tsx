import { Empty, Page, PageHeader } from "@/components/ui/bits";
import { isLive, VideoCard } from "@/components/ui/video-card";
import { listVideos } from "@/lib/api-client";

export const dynamic = "force-dynamic";

const GRID = "grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

export default async function VideosPage() {
  const videos = await listVideos();
  const live = videos.filter(isLive);
  const earlier = videos.filter((video) => !isLive(video));
  return (
    <Page>
      <PageHeader title="Videos" lead="Every stage stream being tracked, and every one that has been." />
      {videos.length === 0 && <Empty>No videos yet. An admin starts one from the Admin page with a YouTube link.</Empty>}
      {live.length > 0 && (
        <section aria-labelledby="live-now" className="mb-10">
          <h2 id="live-now" className="mb-4 text-lg font-semibold">
            Live now
          </h2>
          <div className={GRID}>
            {live.map((video) => (
              <VideoCard key={video.session.id} video={video} />
            ))}
          </div>
        </section>
      )}
      {earlier.length > 0 && (
        <section aria-labelledby="earlier">
          {live.length > 0 && (
            <h2 id="earlier" className="mb-4 text-lg font-semibold">
              Earlier
            </h2>
          )}
          <div className={GRID}>
            {earlier.map((video) => (
              <VideoCard key={video.session.id} video={video} />
            ))}
          </div>
        </section>
      )}
    </Page>
  );
}
