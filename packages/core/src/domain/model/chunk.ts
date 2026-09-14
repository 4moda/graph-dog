/**
 * A chunk: the unit that is embedded, scored and cited.
 *
 * Every chunk carries the exact span of its document that it came from. The
 * predecessor sliced text with `content[:1500]` and reported no positions, so
 * evidence could not be checked against the file; here the span is the point.
 */

import type { Location } from "./location.ts";

export interface Chunk {
  readonly chunkId: string;
  readonly ref: string;
  /** Position of this chunk within its document, 0-based. */
  readonly ordinal: number;
  readonly text: string;
  readonly location: Location;
  /** Breadcrumb of Markdown headings, e.g. `Design > Tokens > Rotation`. */
  readonly headingPath: string;
  /** Number of index terms, used by BM25 length normalization. */
  readonly tokenCount: number;
}

/**
 * Field separator for the chunk-id hash input.
 *
 * A character that cannot occur in a ref or in extracted text, so that
 * concatenating fields cannot produce the same string two different ways.
 */
const FIELD_SEPARATOR = "\u0000";

/**
 * Deterministic chunk id.
 *
 * Content is hashed along with the position, so editing a chunk yields a new
 * id. That stops the dense index from serving a stale vector under a reused
 * key after an incremental update, which is a silent-wrong-answer bug rather
 * than a crash.
 *
 * The hash function is injected so this stays pure and the domain layer never
 * imports `node:crypto`.
 */
export function computeChunkId(
  hash: (input: string) => string,
  input: { ref: string; ordinal: number; startChar: number; endChar: number; text: string },
): string {
  const payload = [
    input.ref,
    String(input.ordinal),
    String(input.startChar),
    String(input.endChar),
    input.text,
  ].join(FIELD_SEPARATOR);
  return hash(payload).slice(0, 20);
}
