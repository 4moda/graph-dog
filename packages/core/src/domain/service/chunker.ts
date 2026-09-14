/**
 * Deterministic, location-preserving chunking.
 *
 * The predecessor sliced text with `content[:1500]` and recorded no positions,
 * so a hit could not be checked against the file it came from. Here every chunk
 * carries the exact character span and the 1-based inclusive line range it was
 * cut from, and the document's full text is kept whole elsewhere.
 *
 * The algorithm: split on Markdown headings into sections, coalesce sections
 * too small to stand alone, then pack each section into windows of at most
 * `maxChars` that end on line boundaries, with a small overlap so a fact
 * straddling a boundary is still retrievable.
 *
 * Pure: no IO, no clock, no randomness. Two runs over the same text produce
 * identical chunks, which is what makes a corpus reproducible.
 */

import { CHUNKING_SCHEMA_VERSION } from "../model/corpus-identity.ts";
import { createLocation, lineAt, lineStarts } from "../model/location.ts";
import { pageAt } from "../model/document.ts";
import type { Location } from "../model/location.ts";
import { headingOutline } from "./markdown.ts";

export interface ChunkingConfig {
  readonly maxChars: number;
  readonly overlapChars: number;
  /** Below this, a section is merged with its neighbour rather than standing alone. */
  readonly minChars: number;
  readonly respectHeadings: boolean;
}

export const DEFAULT_CHUNKING: ChunkingConfig = {
  maxChars: 1200,
  overlapChars: 160,
  minChars: 60,
  respectHeadings: true,
};

export interface DraftChunk {
  readonly ordinal: number;
  readonly text: string;
  readonly location: Location;
  readonly headingPath: string;
}

/**
 * Identity of "how text was cut", stored in the manifest.
 *
 * Two corpora with different fingerprints have incomparable line ranges, so
 * this participates in the compatibility gate. The hash function is injected
 * to keep the domain layer free of `node:crypto`.
 */
export function chunkingFingerprint(
  hash: (input: string) => string,
  config: ChunkingConfig,
): string {
  const payload = [
    `v${CHUNKING_SCHEMA_VERSION}`,
    `max=${config.maxChars}`,
    `ov=${config.overlapChars}`,
    `min=${config.minChars}`,
    `head=${config.respectHeadings ? 1 : 0}`,
  ].join("|");
  return `chunk1:${hash(payload).slice(0, 16)}`;
}

interface Section {
  start: number;
  end: number;
  headingPath: string;
}

/**
 * Cut `text` into located chunks.
 *
 * `pageBreaks` is an ordered list of `[charOffset, pageNumber]` for paginated
 * sources. When present, chunks never straddle a page and carry the page
 * number, so a PDF citation reads as (page, lines within page).
 */
export function chunkText(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING,
  pageBreaks: ReadonlyArray<readonly [number, number]> = [],
): DraftChunk[] {
  if (text.trim() === "") return [];

  const starts = lineStarts(text);
  let sections = splitIntoSections(text, config);
  if (pageBreaks.length > 0) sections = splitOnPages(sections, pageBreaks, text.length);
  sections = coalesceSmallSections(text, sections, config);

  const chunks: DraftChunk[] = [];
  let ordinal = 0;
  for (const section of sections) {
    for (const [from, to] of packWindows(text, section.start, section.end, config)) {
      const body = text.slice(from, to);
      if (body.trim() === "") continue;
      chunks.push({
        ordinal,
        text: body,
        headingPath: section.headingPath,
        location: createLocation({
          startChar: from,
          endChar: to,
          startLine: lineAt(from, starts),
          endLine: lineAt(Math.max(from, to - 1), starts),
          page: pageBreaks.length > 0 ? pageAt(from, pageBreaks) : null,
        }),
      });
      ordinal += 1;
    }
  }
  return chunks;
}

/** Split into sections at Markdown headings, tracking the heading breadcrumb. */
function splitIntoSections(text: string, config: ChunkingConfig): Section[] {
  const whole: Section[] = [{ start: 0, end: text.length, headingPath: "" }];
  if (!config.respectHeadings) return whole;

  const rawLines = text.split("\n");
  const outline = headingOutline(rawLines);
  if (outline.length === 0) return whole;

  // Character offset of the start of each line, plus a sentinel at the end.
  const offsets: number[] = [0];
  for (const line of rawLines) {
    offsets.push((offsets[offsets.length - 1] ?? 0) + line.length + 1);
  }

  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];

  const firstHeadingLine = outline[0]?.lineIndex ?? 0;
  if (firstHeadingLine > 0) {
    const preambleEnd = Math.min(offsets[firstHeadingLine] ?? text.length, text.length);
    if (text.slice(0, preambleEnd).trim() !== "") {
      sections.push({ start: 0, end: preambleEnd, headingPath: "" });
    }
  }

  for (let i = 0; i < outline.length; i += 1) {
    const heading = outline[i];
    if (!heading) continue;
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) stack.pop();
    stack.push({ level: heading.level, title: heading.title });

    const start = Math.min(offsets[heading.lineIndex] ?? 0, text.length);
    const nextLine = outline[i + 1]?.lineIndex;
    const end =
      nextLine === undefined ? text.length : Math.min(offsets[nextLine] ?? text.length, text.length);
    if (text.slice(start, end).trim() === "") continue;
    sections.push({ start, end, headingPath: stack.map((entry) => entry.title).join(" > ") });
  }
  return sections.length > 0 ? sections : whole;
}

/** Intersect section boundaries with page boundaries so no chunk spans two pages. */
function splitOnPages(
  sections: readonly Section[],
  pageBreaks: ReadonlyArray<readonly [number, number]>,
  total: number,
): Section[] {
  const cuts = [...new Set([0, total, ...pageBreaks.map(([offset]) => offset)])].sort(
    (a, b) => a - b,
  );
  const out: Section[] = [];
  for (const section of sections) {
    let cursor = section.start;
    for (const cut of cuts) {
      if (cut > section.start && cut < section.end) {
        out.push({ start: cursor, end: cut, headingPath: section.headingPath });
        cursor = cut;
      }
    }
    if (cursor < section.end) {
      out.push({ start: cursor, end: section.end, headingPath: section.headingPath });
    }
  }
  return out;
}

/**
 * Merge runs of tiny adjacent sections.
 *
 * A document of many one-line headings would otherwise produce one chunk per
 * heading. Dropping the short ones instead -- which the predecessor did via a
 * minimum-length filter -- loses content outright, so they are joined. Sections
 * are contiguous, so merging preserves the character span exactly.
 */
function coalesceSmallSections(
  text: string,
  sections: readonly Section[],
  config: ChunkingConfig,
): Section[] {
  if (sections.length === 0) return [];
  const out: Section[] = [];
  let pending: Section | undefined;

  for (const section of sections) {
    if (pending === undefined) {
      pending = { ...section };
      continue;
    }
    const tooSmall = text.slice(pending.start, pending.end).trim().length < config.minChars;
    const fits = section.end - pending.start <= config.maxChars;
    const adjacent = pending.end === section.start;
    if (tooSmall && fits && adjacent) {
      pending = {
        start: pending.start,
        end: section.end,
        headingPath: pending.headingPath || section.headingPath,
      };
    } else {
      out.push(pending);
      pending = { ...section };
    }
  }

  if (pending !== undefined) {
    // A trailing short section joins the previous chunk when it fits, and
    // stands alone otherwise. It is never discarded.
    const last = out[out.length - 1];
    const tooSmall = text.slice(pending.start, pending.end).trim().length < config.minChars;
    if (last && tooSmall && last.end === pending.start && pending.end - last.start <= config.maxChars) {
      out[out.length - 1] = { ...last, end: pending.end };
    } else {
      out.push(pending);
    }
  }
  return out;
}

/** Pack `[start, end)` into windows that end on line boundaries, with overlap. */
function packWindows(
  text: string,
  start: number,
  end: number,
  config: ChunkingConfig,
): Array<[number, number]> {
  if (end - start <= config.maxChars) return [[start, end]];

  const windows: Array<[number, number]> = [];
  let cursor = start;
  let guard = 0;
  const maxIterations = Math.ceil((end - start) / Math.max(1, config.maxChars)) * 4 + 16;

  while (cursor < end && guard < maxIterations) {
    guard += 1;
    let target = Math.min(cursor + config.maxChars, end);
    if (target < end) {
      // Prefer a paragraph break, then any line break, so chunks stay readable.
      const searchFrom = cursor + Math.floor(config.maxChars / 2);
      let split = text.lastIndexOf("\n\n", target);
      if (split < searchFrom) split = text.lastIndexOf("\n", target);
      if (split >= searchFrom && split > cursor) target = split + 1;
    }
    windows.push([cursor, target]);
    if (target >= end) break;

    // Step back by the overlap, then snap forward to a line boundary so the
    // overlapping window still begins on a whole line.
    const backTo = Math.max(cursor + 1, target - config.overlapChars);
    const newline = text.lastIndexOf("\n", backTo);
    const next = newline > cursor ? newline + 1 : backTo;
    cursor = next > cursor ? next : target;
  }
  return windows;
}
