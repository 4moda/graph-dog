/**
 * Owning part of a file that belongs to somebody else.
 *
 * An agent's instruction file -- `CLAUDE.md` and its equivalents -- is the
 * user's, and other tools write to it too: in this repository alone,
 * code-review-graph has its own section in the same file. So GraphDog claims a
 * marked-off region and nothing else. Everything here is a pure string
 * function, which is what makes "never touches a byte outside its markers"
 * something a test can state rather than something a reviewer has to believe.
 *
 * The round trip is the property that matters: writing a block into a file and
 * then removing it gives back the original text, byte for byte, including the
 * blank line the insert added. An uninstall that leaves debris is an uninstall
 * nobody trusts a second time.
 */

import { ConfigError } from "../errors.ts";

export interface BlockMarkers {
  /** The whole opening line, e.g. `<!-- graphdog -->`. */
  readonly open: string;
  /** The whole closing line, e.g. `<!-- /graphdog -->`. */
  readonly close: string;
}

/** Markers for a file whose comments are HTML, such as Markdown. */
export function htmlMarkers(name: string): BlockMarkers {
  return { open: `<!-- ${name} -->`, close: `<!-- /${name} -->` };
}

/** Markers for a file whose comments start with `#`, such as a shell script. */
export function hashMarkers(name: string): BlockMarkers {
  return { open: `# >>> ${name}`, close: `# <<< ${name}` };
}

interface Span {
  /** Index of the first character of the opening marker line. */
  readonly from: number;
  /** Index just past the closing marker's line ending. */
  readonly to: number;
}

/**
 * Locate the block, or report that there is none.
 *
 * A file with an opening marker and no closing one is refused rather than
 * repaired. Someone edited it by hand and the region GraphDog owns is no longer
 * known; appending a second block, or guessing where the first ends, would
 * destroy whatever they were in the middle of.
 */
function locate(text: string, markers: BlockMarkers): Span | null {
  const open = indexOfLine(text, markers.open);
  const close = indexOfLine(text, markers.close);

  if (open === null && close === null) return null;
  if (open === null || close === null || close < open) {
    throw new ConfigError(
      `the ${markers.open} block is malformed: it must have both an opening and a closing marker, in that order`,
      { open: markers.open, close: markers.close, remedy: "restore or delete the markers by hand" },
    );
  }

  let to = close + markers.close.length;
  if (text.startsWith("\r\n", to)) to += 2;
  else if (text.startsWith("\n", to)) to += 1;
  return { from: open, to };
}

/** Index of a line equal to `line`, ignoring trailing spaces; null when absent. */
function indexOfLine(text: string, line: string): number | null {
  let at = 0;
  for (;;) {
    const found = text.indexOf(line, at);
    if (found === -1) return null;
    const startsLine = found === 0 || text[found - 1] === "\n";
    const rest = text.slice(found + line.length);
    const endsLine = /^[ \t]*(\r?\n|$)/.test(rest);
    if (startsLine && endsLine) return found;
    at = found + line.length;
  }
}

/** Is this file already carrying a block of ours? */
export function hasBlock(text: string, markers: BlockMarkers): boolean {
  return locate(text, markers) !== null;
}

/**
 * Put `body` in the block, replacing what was there or appending a new one.
 *
 * An appended block is separated from the existing text by exactly one blank
 * line, whatever the file ended with, and `removeBlock` takes that line back.
 * Normalizing rather than preserving is deliberate: with two blank lines kept,
 * removal cannot tell the one it added from the one that was there, and an
 * uninstall leaves debris. One trailing newline -- what a file normally ends
 * with -- survives an install and an uninstall unchanged.
 */
export function upsertBlock(text: string, markers: BlockMarkers, body: string): string {
  const block = `${markers.open}\n${body.replace(/\n+$/, "")}\n${markers.close}\n`;
  const span = locate(text, markers);
  if (span !== null) return text.slice(0, span.from) + block + text.slice(span.to);
  const before = text.replace(/\n+$/, "");
  if (before === "") return block;
  return `${before}\n\n${block}`;
}

/**
 * Take the block out, and the blank line an append put before it.
 *
 * Returns null when there was nothing of ours here, so a caller can tell "we
 * removed it" from "it was already gone" without comparing strings.
 */
export function removeBlock(text: string, markers: BlockMarkers): string | null {
  const span = locate(text, markers);
  if (span === null) return null;

  let from = span.from;
  // One blank line before the block is ours if the text does not end there --
  // it is what `upsertBlock` inserted as a separator.
  if (from >= 2 && text.startsWith("\n\n", from - 2)) from -= 1;
  const out = text.slice(0, from) + text.slice(span.to);
  return out === "\n" ? "" : out;
}
