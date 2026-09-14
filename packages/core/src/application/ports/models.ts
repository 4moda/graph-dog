/**
 * Embedding and reranking ports.
 *
 * Both are optional capabilities with a working default, which is what keeps
 * GraphDog installable and usable with no model downloads and no network.
 */

export interface EmbeddingModel {
  /**
   * Identity recorded in the corpus manifest.
   *
   * Vectors from two different identities are not comparable, so this string
   * is checked before any search runs. It must change whenever anything that
   * changes the vectors changes: the model, its dimension, or its prompt
   * prefixes.
   */
  readonly id: string;
  readonly dimensions: number;
  /** True when the model captures meaning rather than surface form. */
  readonly semantic: boolean;
  /**
   * Cosine below which a result is noise rather than a weak match.
   *
   * Only the model knows what its similarity scale means. A lexical hashing
   * embedder produces meaningful similarity from bucket collisions between
   * unrelated texts, so its floor is high; an E5-family model scores almost
   * everything above 0.7, so a low floor there would filter nothing. Putting
   * this on the model rather than in shared config is what lets the two be
   * swapped without retuning search.
   */
  readonly minUsefulSimilarity: number;
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface RerankCandidate {
  readonly id: string;
  readonly text: string;
}

export interface RerankResult {
  readonly id: string;
  readonly score: number;
}

/**
 * A cross-encoder that re-scores a shortlist against the query.
 *
 * Reranking reads the query and the passage together instead of comparing two
 * independently produced vectors, which is why it is markedly more accurate --
 * and why it is too slow to run over a whole corpus. It runs on the top of the
 * fused list only, and it is always optional.
 */
export interface Reranker {
  readonly id: string;
  rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RerankResult[]>;
}
