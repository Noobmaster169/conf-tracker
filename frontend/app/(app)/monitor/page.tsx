import { MonitorFeed } from "@/components/monitor-feed";
import { Page, PageHeader } from "@/components/ui/bits";
import { FEED_CACHE_S, getFeed } from "@/lib/api-client";

export const dynamic = "force-dynamic";

export default async function MonitorPage() {
  return (
    <Page narrow>
      <PageHeader title="Monitor" lead="What was claimed on stage, and who claimed it. Newest first, from every tracked video." />
      <MonitorFeed initial={await getFeed("", FEED_CACHE_S)} />
    </Page>
  );
}
