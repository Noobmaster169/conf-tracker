/**
 * A pull-quote's attribution must be its own paragraph to be styled as one, which in Markdown needs a blank `>` line
 * before it. The prompt asks for that; this makes it true even when the model writes the two lines back to back,
 * which would otherwise fold the attribution into the quote. (As in yt-engine's components/markdown.tsx.)
 */
export function separateAttributions(markdown: string): string {
  return markdown.replace(/^(>[^\n]*\S[^\n]*)\n(?=> *\u2014 )/gm, "$1\n>\n");
}
