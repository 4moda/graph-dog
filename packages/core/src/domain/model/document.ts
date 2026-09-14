/**
 * A source document as the index knows it.
 *
 * `ref` is the stable, OS-independent identity used everywhere in the public
 * contract: `<source-id>/<posix-relative-path>`. An agent quotes it, `read`
 * takes it, and a corpus built on Windows must produce the same string as one
 * built on Linux, so backslashes and drive letters never appear here.
 *
 * `text` is the *complete* extracted content. It is deliberately stored whole:
 * the point of the tool is to hand back verifiable evidence, and truncating at
 * index time makes that impossible after the fact.
 */

import { countLines } from "./location.ts";

export interface DocumentRef {
  readonly sourceId: string;
  readonly relativePath: string;
}

export interface SourceDocument {
  readonly ref: string;
  readonly sourceId: string;
  readonly title: string;
  readonly mediaType: string;
  /** Content hash of the raw bytes; the basis for incremental rebuilds. */
  readonly contentHash: string;
  readonly size: number;
  readonly mtime: number;
  readonly revision: string | null;
  readonly indexedAt: string;
  readonly totalLines: number;
  readonly text: string;
  /** `[charOffset, pageNumber]` pairs for paginated formats; empty otherwise. */
  readonly pageBreaks: ReadonlyArray<readonly [number, number]>;
  readonly tags: readonly string[];
  readonly links: readonly string[];
}

const BACKSLASH = /\\/g;
const REPEATED_SLASH = /\/{2,}/g;

/**
 * Build a portable `ref` from a source id and a relative path.
 *
 * Windows separators are normalized and `.`/`..` segments are resolved away, so
 * a ref can never escape its source or vary by platform.
 */
export function makeRef(sourceId: string, relativePath: string): string {
  const normalized = relativePath.replace(BACKSLASH, "/").replace(REPEATED_SLASH, "/");
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${sourceId}/${segments.join("/")}`;
}

/** Split a `ref` back into its source id and relative path. */
export function parseRef(ref: string): DocumentRef | null {
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return null;
  return { sourceId: ref.slice(0, separator), relativePath: ref.slice(separator + 1) };
}

/** Directory portion of a ref, or `""` for a document at a source root. */
export function refDirectory(ref: string): string {
  const separator = ref.lastIndexOf("/");
  return separator <= 0 ? "" : ref.slice(0, separator);
}

/** Filename portion of a ref. */
export function refBasename(ref: string): string {
  const separator = ref.lastIndexOf("/");
  return separator < 0 ? ref : ref.slice(separator + 1);
}

/** Page number containing a character offset, or null for unpaginated text. */
export function pageAt(
  offset: number,
  pageBreaks: ReadonlyArray<readonly [number, number]>,
): number | null {
  if (pageBreaks.length === 0) return null;
  let page = pageBreaks[0]?.[1] ?? null;
  for (const [breakOffset, pageNumber] of pageBreaks) {
    if (breakOffset <= offset) page = pageNumber;
    else break;
  }
  return page;
}

/** Extract an inclusive 1-based line range, as `read` returns it. */
export function sliceLines(
  text: string,
  startLine: number,
  endLine: number,
): { text: string; startLine: number; endLine: number } {
  const lines = text.split("\n");
  const total = countLines(text);
  const from = Math.max(1, Math.min(startLine, total || 1));
  const to = Math.max(from, Math.min(endLine, total || 1));
  return { text: lines.slice(from - 1, to).join("\n"), startLine: from, endLine: to };
}
