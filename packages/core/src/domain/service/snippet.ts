/**
 * Choosing the excerpt that actually shows why a chunk matched.
 *
 * "First N characters" is the obvious implementation and the wrong one: the
 * evidence an agent needs is rarely at the top of a chunk, and a snippet that
 * does not contain the query terms forces a follow-up `read` for every hit.
 * This slides a window over the text and keeps the densest cluster of query
 * term occurrences.
 */

import { stripMarkdown } from "./markdown.ts";
import { tokenize } from "./tokenizer.ts";

export const ELLIPSIS = "…";

/** Collapse Markdown and whitespace into one display line. */
export function flatten(text: string): string {
  return stripMarkdown(text)
    .replace(/[ \t]*\r?\n[ \t]*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Pick the window of `text` that best covers the query terms.
 *
 * Falls back to the head of the chunk when no query term is present, which
 * happens for graph-reached hits: those were found through a relationship
 * rather than a term match, so the opening is the most useful thing to show.
 */
export function bestSnippet(text: string, query: string, maxChars = 320): string {
  const flat = flatten(text);
  if (flat === "") return "";
  if (flat.length <= maxChars) return flat;

  const head = (): string => `${flat.slice(0, maxChars).trimEnd()}${ELLIPSIS}`;

  const terms = new Set(tokenize(query));
  if (terms.size === 0) return head();

  const haystack = flat.normalize("NFKC").toLowerCase();
  const positions: number[] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const found = haystack.indexOf(term, from);
      if (found < 0) break;
      positions.push(found);
      from = found + Math.max(1, term.length);
      if (positions.length > 512) break;
    }
  }
  if (positions.length === 0) return head();

  positions.sort((a, b) => a - b);
  let bestStart = positions[0] ?? 0;
  let bestCount = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const anchor = positions[i] ?? 0;
    let j = i;
    while (j < positions.length && (positions[j] ?? 0) - anchor <= maxChars) j += 1;
    if (j - i > bestCount) {
      bestCount = j - i;
      bestStart = anchor;
    }
  }

  // Leave a third of the window as leading context so the match is not flush
  // against the left edge, which reads as truncated mid-sentence.
  const start = Math.max(0, bestStart - Math.floor(maxChars / 3));
  const end = Math.min(flat.length, start + maxChars);
  let snippet = flat.slice(start, end).trim();
  if (start > 0) snippet = ELLIPSIS + snippet;
  if (end < flat.length) snippet = snippet + ELLIPSIS;
  return snippet;
}
