import type { SummaryBody } from "@/lib/api/conference";

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 font-semibold">{title}</h3>
      <ul className="max-w-[72ch] list-disc space-y-1.5 pl-5 marker:text-ink-faint">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

/** A finished session as a briefing: the one-line news first, then the argument, then the lists a reader scans for. */
export function Summary({ summary }: { summary: SummaryBody }) {
  return (
    <div className="space-y-7">
      <p className="max-w-[40ch] text-[26px] font-semibold leading-tight tracking-tight">{summary.headline}</p>
      <p className="max-w-[72ch] text-[17px] leading-relaxed">{summary.overview}</p>
      <List title="Key points" items={summary.key_points} />
      <List title="Announcements" items={summary.announcements} />
      <List title="Numbers" items={summary.numbers} />
      {summary.quotes.length > 0 && (
        <section>
          <h3 className="mb-3 font-semibold">In their words</h3>
          <div className="space-y-4">
            {summary.quotes.map((q) => (
              <figure key={q.quote} className="max-w-[72ch] border-l-[3px] border-accent pl-4">
                <blockquote className="text-[17px] leading-snug">&ldquo;{q.quote}&rdquo;</blockquote>
                {q.speaker && <figcaption className="mt-1 text-[13px] text-ink-soft">{q.speaker}</figcaption>}
              </figure>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
