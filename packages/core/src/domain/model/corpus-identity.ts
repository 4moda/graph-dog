/**
 * The three identities that decide whether a corpus can be searched.
 *
 * - `schemaVersion`        the physical layout of the store
 * - `embeddingId`          which model produced the vectors in the dense index
 * - `chunkingFingerprint`  how text was cut, which is what line ranges *mean*
 *
 * Any mismatch is refused explicitly. This is the rule that stops a corpus
 * built with one embedding model from being queried with another: the cosine
 * numbers would still come out, ranked confidently, and be meaningless.
 */

/** Physical corpus layout: tables, blob encodings, manifest keys. */
export const SCHEMA_VERSION = "1";

/** Chunking algorithm generation. Bumping this invalidates stored line ranges. */
export const CHUNKING_SCHEMA_VERSION = "1";

export interface CorpusIdentity {
  readonly schemaVersion: string;
  readonly embeddingId: string;
  readonly chunkingFingerprint: string;
  readonly chunkingSchemaVersion: string;
}

export interface IdentityExpectation {
  /** Omit to accept whatever the corpus itself declares. */
  readonly embeddingId?: string;
  readonly chunkingFingerprint?: string;
}

export interface IncompatibilityReason {
  readonly field: "schemaVersion" | "chunkingSchemaVersion" | "embeddingId" | "chunkingFingerprint";
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}

/**
 * Returns `null` when the corpus is usable, otherwise a structured reason.
 *
 * The reason is structured rather than a string so the CLI can print prose,
 * the MCP server can hand back a machine-readable cause, and tests can assert
 * on the field rather than on wording.
 */
export function checkIdentity(
  actual: Partial<CorpusIdentity>,
  expected: IdentityExpectation = {},
): IncompatibilityReason | null {
  const schemaVersion = actual.schemaVersion ?? "";
  if (schemaVersion !== SCHEMA_VERSION) {
    return {
      field: "schemaVersion",
      expected: SCHEMA_VERSION,
      actual: schemaVersion || "<missing>",
      message:
        `corpus schema version ${schemaVersion || "<missing>"} is not supported ` +
        `(this build reads version ${SCHEMA_VERSION}); rebuild the corpus`,
    };
  }

  const chunkingSchema = actual.chunkingSchemaVersion ?? "";
  if (chunkingSchema !== "" && chunkingSchema !== CHUNKING_SCHEMA_VERSION) {
    return {
      field: "chunkingSchemaVersion",
      expected: CHUNKING_SCHEMA_VERSION,
      actual: chunkingSchema,
      message:
        `chunking schema ${chunkingSchema} is not supported ` +
        `(this build reads version ${CHUNKING_SCHEMA_VERSION}); stored line ranges ` +
        `cannot be trusted, so a rebuild is required`,
    };
  }

  if (expected.embeddingId !== undefined && actual.embeddingId !== expected.embeddingId) {
    return {
      field: "embeddingId",
      expected: expected.embeddingId,
      actual: actual.embeddingId ?? "<missing>",
      message:
        `corpus was indexed with embedding ${actual.embeddingId ?? "<missing>"} but the ` +
        `current configuration uses ${expected.embeddingId}; dense vectors are not ` +
        `comparable, so a rebuild is required`,
    };
  }

  if (
    expected.chunkingFingerprint !== undefined &&
    actual.chunkingFingerprint !== expected.chunkingFingerprint
  ) {
    return {
      field: "chunkingFingerprint",
      expected: expected.chunkingFingerprint,
      actual: actual.chunkingFingerprint ?? "<missing>",
      message:
        `corpus was chunked as ${actual.chunkingFingerprint ?? "<missing>"} but the current ` +
        `configuration produces ${expected.chunkingFingerprint}; evidence locations are ` +
        `not comparable, so a rebuild is required`,
    };
  }

  return null;
}
