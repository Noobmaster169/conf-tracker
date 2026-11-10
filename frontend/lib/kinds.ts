import type { ClaimKind } from "./api/schemas";

/** What each kind of claim is called on the page, in the order the filter offers them. */
export const KINDS: { kind: ClaimKind; label: string; plural: string }[] = [
  { kind: "announcement", label: "Announcement", plural: "Announcements" },
  { kind: "metric", label: "Number", plural: "Numbers" },
  { kind: "roadmap", label: "Roadmap", plural: "Roadmap" },
  { kind: "opinion", label: "Opinion", plural: "Opinions" },
  { kind: "fact", label: "Fact", plural: "Facts" },
];

export function kindLabel(kind: ClaimKind | null): string | null {
  return KINDS.find((k) => k.kind === kind)?.label ?? null;
}

/** A claim the extractor rated 4 or 5: news, not colour. */
export function isMajor(importance: number | null): boolean {
  return importance !== null && importance >= 4;
}
