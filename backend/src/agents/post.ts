import { z } from "zod";

import type { Stage, Talk, TalkPost } from "../contracts";
import type { FeedItem } from "../contracts-views";
import { speakerList, stageLine } from "../pipeline/tracking";
import * as posts from "../repositories/posts";
import { callStructured, type StructuredDeps } from "./structured";

const MAX_EMOJI = 3;
// A talk's claims beyond these add length, not highlights: the most important come first.
const MAX_CLAIMS = 60;
// About 15k tokens of write-up; the longest summaries are well under it.
const MAX_SUMMARY_CHARS = 60_000;

const BULLET = /^•\s+\S/;
const emojiCount = (text: string): number => (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;

/** The Poster's answer: the post without its footer, which the code adds. */
export const PostOutput = z.object({
  post: z
    .string()
    .trim()
    .min(1)
    .superRefine((text, ctx) => {
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      if (!lines[0] || BULLET.test(lines[0])) ctx.addIssue({ code: "custom", message: 'the first line must be the header ("🔴 Just wrapped: ...")' });
      if (lines.filter((line) => BULLET.test(line)).length < 2) ctx.addIssue({ code: "custom", message: 'the highlights must be at least two lines starting with "• "' });
      if (emojiCount(text) > MAX_EMOJI) ctx.addIssue({ code: "custom", message: `use at most ${MAX_EMOJI} emoji in the whole post, counting the 🔴; this one has ${emojiCount(text)}` });
      if (/https?:\/\//.test(text)) ctx.addIssue({ code: "custom", message: "no links: the line with the stream's link is added under the post for you" });
    }),
});
export type PostOutput = z.infer<typeof PostOutput>;

export interface PostInput {
  stage: Stage;
  talk: Talk;
  claims: FeedItem[];
  /** The summary article in markdown. */
  summary: string;
  /** How long the talk was on stage, in minutes; null when not known. */
  minutes?: number | null;
}

/** The claims a post is chosen from: the most important first, then in the order they were said. */
export function rankClaims(claims: FeedItem[]): FeedItem[] {
  return [...claims].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (a.t0 ?? 0) - (b.t0 ?? 0)).slice(0, MAX_CLAIMS);
}

function claimLine(claim: FeedItem): string {
  const who = claim.person?.name ?? claim.speaker_name;
  const tags = [claim.importance === null ? null : `importance ${claim.importance}`, claim.kind].filter(Boolean).join(", ");
  return `- ${tags ? `[${tags}] ` : ""}${claim.claim}${who ? ` (${who})` : ""}`;
}

/** The user message: the session, its claims, then the write-up. */
export function renderPostInput({ stage, talk, claims, summary, minutes = null }: PostInput): string {
  const ranked = rankClaims(claims);
  const article = summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}\n[... the rest is left out for length ...]` : summary;
  return [
    `Conference: ${stage.conference}`,
    `Stage: ${stageLine(stage)}`,
    `Session: "${talk.title}" (${talk.kind})`,
    minutes === null ? null : `Duration: ~${Math.max(1, Math.round(minutes))} minutes on stage`,
    talk.description ? `About: ${talk.description}` : null,
    `On stage: ${speakerList(talk)}`,
    "",
    `Claims (${ranked.length}, most important first):`,
    ranked.length > 0 ? ranked.map(claimLine).join("\n") : "(none tracked)",
    "",
    "Write-up:",
    article,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** The post as it is stored and shown: the model's text, then the footer after a blank line. */
export function withFooter(post: string, footer: string): string {
  const body = post.trim();
  return footer.trim() ? `${body}\n\n${footer.trim()}` : body;
}

/**
 * One post of one talk, written from its claims and summary and stored with the call that wrote it. Every attempt is a
 * row in llm_calls. Null when the model failed; the reason is on the call's row.
 */
export async function runPost(
  deps: StructuredDeps,
  input: PostInput & { window: { t0: number; t1: number }; footer: string },
): Promise<TalkPost | null> {
  let stored: TalkPost | null = null;
  const { data } = await callStructured(deps, PostOutput, { ...input.window, talkId: input.talk.id }, renderPostInput(input), async (tx, call, answer) => {
    stored = await posts.insert(tx, { talkId: input.talk.id, sessionId: deps.sessionId, callId: call.id, text: withFooter(answer.post, input.footer) });
  });
  return data ? stored : null;
}
