/**
 * Fetching the verbatim text behind a citation.
 *
 * This is what makes a hit *evidence* rather than a claim: an agent can take
 * the `read_ref` from any result and get back the exact lines, unmodified.
 *
 * Truncation is always reported. Returning a silently shortened document is
 * the failure mode that makes an agent confidently cite half a paragraph.
 */

import { RefNotFoundError } from "../../domain/errors.ts";
import { createLocation, type Location } from "../../domain/model/location.ts";
import { sliceLines } from "../../domain/model/document.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { Warning } from "../dto/mappers.ts";
import type { CorpusStore } from "../ports/repositories.ts";

/** Default ceiling, so a careless `read` of a huge file cannot flood a context window. */
export const DEFAULT_MAX_CHARS = 60_000;

export interface ReadOptions {
  /** `docs/a.md`, `docs/a.md#L10-L24`, or `docs/a.md#p3L4-L9`. */
  readonly ref: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxChars?: number;
}

export interface ReadDependencies {
  readonly store: CorpusStore;
  readonly corpusName: string;
}

export interface ReadOutcome {
  readonly corpus: string;
  readonly ref: string;
  readonly title: string;
  readonly text: string;
  readonly location: Location;
  readonly totalLines: number;
  readonly truncated: boolean;
  readonly sourceRevision: string | null;
  readonly warnings: Warning[];
}

export interface ParsedRef {
  readonly ref: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly page: number | null;
}

const RANGE = /^(?:p(?<page>\d+))?L(?<start>\d+)(?:-L?(?<end>\d+))?$/;

/**
 * Split a citation into a ref and an optional range.
 *
 * Accepts exactly what `read_ref` emits, so a result can be round-tripped
 * without the caller reformatting anything.
 */
export function parseRefWithRange(input: string): ParsedRef {
  const hash = input.lastIndexOf("#");
  if (hash < 0) return { ref: input, startLine: null, endLine: null, page: null };

  const ref = input.slice(0, hash);
  const match = RANGE.exec(input.slice(hash + 1));
  if (match?.groups === undefined) {
    // Not a range: an anchor such as `#section`, which identifies the document.
    return { ref, startLine: null, endLine: null, page: null };
  }
  const start = Number(match.groups["start"]);
  const end = match.groups["end"] === undefined ? start : Number(match.groups["end"]);
  const page = match.groups["page"] === undefined ? null : Number(match.groups["page"]);
  return { ref, startLine: start, endLine: end, page };
}

export function readDocument(options: ReadOptions, dependencies: ReadDependencies): ReadOutcome {
  const { store, corpusName } = dependencies;
  const parsed = parseRefWithRange(options.ref);

  const document = store.documents.get(parsed.ref);
  if (document === null) {
    throw new RefNotFoundError(`document not found in corpus: ${parsed.ref}`, {
      ref: parsed.ref,
      corpus: corpusName,
      hint: "run 'graphdog search' to find a valid ref, or rebuild the corpus",
    });
  }

  const warnings: Warning[] = [];
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const requestedStart = options.startLine ?? parsed.startLine;
  const requestedEnd = options.endLine ?? parsed.endLine;

  let text = document.text;
  let location = createLocation({
    startLine: 1,
    endLine: Math.max(1, document.totalLines),
    startChar: 0,
    endChar: document.text.length,
    page: null,
  });

  if (requestedStart !== null && requestedStart !== undefined) {
    const end = requestedEnd ?? requestedStart;
    const slice = sliceLines(document.text, requestedStart, end);
    text = slice.text;
    const startChar = charOffsetOfLine(document.text, slice.startLine);
    location = createLocation({
      startLine: slice.startLine,
      endLine: slice.endLine,
      startChar,
      endChar: startChar + slice.text.length,
      page: parsed.page,
    });
    if (slice.startLine !== requestedStart || slice.endLine !== end) {
      warnings.push({
        code: WarningCode.RANGE_CLAMPED,
        message:
          `requested lines ${requestedStart}-${end} were clamped to ` +
          `${slice.startLine}-${slice.endLine}; the document has ${document.totalLines} lines`,
        details: { requested: [requestedStart, end], returned: [slice.startLine, slice.endLine] },
      });
    }
  }

  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
    warnings.push({
      code: WarningCode.RANGE_CLAMPED,
      message:
        `output truncated to ${maxChars} characters; request a line range to read a ` +
        `specific section, or raise the limit`,
      details: { max_chars: maxChars, total_chars: document.text.length },
    });
  }

  return {
    corpus: corpusName,
    ref: parsed.ref,
    title: document.title,
    text,
    location,
    totalLines: document.totalLines,
    truncated,
    sourceRevision: document.revision,
    warnings,
  };
}

/** Character offset where a 1-based line begins. */
function charOffsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  let seen = 1;
  while (seen < line) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return offset;
    offset = next + 1;
    seen += 1;
  }
  return offset;
}
