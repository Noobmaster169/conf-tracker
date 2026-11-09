export interface Marked {
  before: string;
  hit: string;
  after: string;
}

// A transcript line's prefix in the rendered window (backend/src/pipeline/window.ts renderLine).
// The class excludes a newline so a stray bracket cannot swallow the next line.
const LINE_PREFIX = /^\[\d{2,}:\d{2} [^\]\n]*\] /gm;
// A retry appends the model's own earlier answer (backend/src/agents/extract.ts); it is not transcript.
const RETRY_SUFFIX = "\n\n## your previous answer";
const ALREADY_HEADER = "## already extracted";

/** Marks every character of the searched text that is not a transcript line's text. */
function nonTranscript(text: string): Uint8Array {
  const skip = new Uint8Array(text.length);
  let inAlready = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    if (line.startsWith("## ")) inAlready = line.startsWith(ALREADY_HEADER);
    if (inAlready || line.startsWith("## ") || line === "(none)") skip.fill(1, offset, end);
    offset = end + 1;
  }
  for (const match of text.matchAll(LINE_PREFIX)) skip.fill(1, match.index, match.index + match[0].length);
  return skip;
}

/**
 * Where a quote sits in the rendered window, with only whitespace forgiven on either side, so
 * the drawer marks exactly what the backend's evidence check matched (pipeline/evidence.ts:
 * last occurrence wins). The backend joins the transcript lines' texts only, so everything that
 * is not a line's text counts as whitespace here: section headers, `(none)`, the already-extracted
 * bullets and the `[mm:ss S3] ` prefixes. A retry's echoed previous answer is not searched at
 * all. A quote that runs across two lines, or across the new-lines header, is still found.
 */
export function markQuote(text: string, quote: string): Marked | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (needle === "") return null;
  const cut = text.indexOf(RETRY_SUFFIX);
  const searched = cut === -1 ? text : text.slice(0, cut);
  const skip = nonTranscript(searched);
  // Walk the text once, collapsing whitespace runs, and remember where each kept character came from.
  let collapsed = "";
  const origin: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < searched.length; i++) {
    const char = searched[i]!;
    if (skip[i] === 1 || /\s/.test(char)) {
      pendingSpace = collapsed.length > 0;
      continue;
    }
    if (pendingSpace) {
      collapsed += " ";
      origin.push(i - 1);
      pendingSpace = false;
    }
    collapsed += char;
    origin.push(i);
  }
  const at = collapsed.lastIndexOf(needle);
  if (at === -1) return null;
  const start = origin[at]!;
  const end = origin[at + needle.length - 1]! + 1;
  return { before: text.slice(0, start), hit: text.slice(start, end), after: text.slice(end) };
}
