/**
 * Where a piece of evidence sits inside its source document.
 *
 * This is the value object that makes an answer auditable: `ref` says which
 * document, `Location` says exactly where in it, and `read` can hand back the
 * same span verbatim. Lines are 1-based and inclusive, matching what an editor
 * and a reviewer would say.
 *
 * For paginated formats (PDF, slides, spreadsheets) `page` is set and lines are
 * numbered *within* the page, so a citation stays meaningful even if the text
 * layer is re-extracted and absolute offsets shift.
 */

export interface Location {
  readonly startLine: number;
  readonly endLine: number;
  readonly startChar: number;
  readonly endChar: number;
  readonly page: number | null;
}

export function createLocation(input: {
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  page?: number | null;
}): Location {
  return {
    startLine: input.startLine,
    endLine: input.endLine,
    startChar: input.startChar,
    endChar: input.endChar,
    page: input.page ?? null,
  };
}

/** Human-facing citation suffix, e.g. `#L12-L30` or `#p3L4-L9`. */
export function formatLocation(location: Location): string {
  const lines =
    location.startLine === location.endLine
      ? `L${location.startLine}`
      : `L${location.startLine}-L${location.endLine}`;
  return location.page === null ? `#${lines}` : `#p${location.page}${lines}`;
}

/** Character offset of the first character of every line. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number containing `offset`, via binary search over `starts`. */
export function lineAt(offset: number, starts: readonly number[]): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Total line count, counting a trailing newline as ending the last line. */
export function countLines(text: string): number {
  if (text === "") return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlines : newlines + 1;
}
