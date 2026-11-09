import type { Metadata } from "next";

import { Explorer } from "@/components/claims/explorer";
import { SearchBox } from "@/components/claims/search-box";
import { Nav } from "@/components/nav";
import type { ClaimSearch } from "@/lib/api/claim-schemas";
import { searchClaims } from "@/lib/api/sessions";
import { parseFilters, toQuery } from "@/lib/claim-filters";
import { videoTitles } from "@/lib/video-title";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "claims · yt-stream" };

export default async function ClaimsPage({ searchParams }: PageProps<"/claims">) {
  const filters = parseFilters(await searchParams);
  const query = toQuery(filters);
  let data: ClaimSearch;
  try {
    data = await searchClaims(query);
  } catch (error) {
    return (
      <>
        <Nav current="claims" />
        <main className="mx-auto max-w-7xl px-4 pb-16">
          <div className="pt-4">
            <SearchBox filters={filters} />
          </div>
          <p className="py-3 text-bad">{error instanceof Error ? error.message : String(error)}</p>
        </main>
      </>
    );
  }
  const titles = await videoTitles(data.shows.map((show) => show.video_id));
  return (
    <>
      <Nav current="claims" />
      <main className="mx-auto max-w-7xl px-4 pb-16">
        {/* Outside the keyed explorer, so the box keeps focus and its text while each search re-renders the page. */}
        <div className="pt-4">
          <SearchBox filters={filters} />
        </div>
        <Explorer key={`${query}@${data.as_of}`} filters={filters} data={data} titles={titles} />
      </main>
    </>
  );
}
