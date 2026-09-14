/**
 * Keys under which a corpus records what it is.
 *
 * Centralized because the build writes them, `status` reads them, the
 * compatibility gate compares them, and the archive manifest copies them.
 * Four call sites agreeing on string literals is exactly how a schema drifts.
 */

export const CORPUS_META_KEYS = {
  schemaVersion: "schema_version",
  corpusName: "corpus_name",
  builtAt: "built_at",
  embeddingId: "embedding_id",
  embeddingDimensions: "embedding_dimensions",
  embeddingSemantic: "embedding_semantic",
  chunkingFingerprint: "chunking_fingerprint",
  chunkingConfig: "chunking_config",
  chunkingSchemaVersion: "chunking_schema_version",
  bm25ChunkCount: "bm25_chunk_count",
  bm25AverageLength: "bm25_average_length",
} as const;

export type CorpusMetaKey = (typeof CORPUS_META_KEYS)[keyof typeof CORPUS_META_KEYS];
