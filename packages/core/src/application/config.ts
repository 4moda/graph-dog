/**
 * Resolved configuration for one corpus.
 *
 * This is the application-layer view: already validated, defaults filled in,
 * and free of any file-format concern. Parsing `graphdog.json` is an
 * infrastructure job; use cases only ever see this shape.
 */

import type { ChunkingConfig } from "../domain/service/chunker.ts";
import { DEFAULT_CHUNKING } from "../domain/service/chunker.ts";
import type { FusionConfig } from "../domain/service/fusion.ts";
import { DEFAULT_FUSION } from "../domain/service/fusion.ts";
import type { GraphRules } from "../domain/service/graph-builder.ts";
import { DEFAULT_GRAPH_RULES } from "../domain/service/graph-builder.ts";
import type { SourceSpec } from "./ports/sources.ts";

export interface EmbeddingConfig {
  /** `hash` for the built-in lexical embedder, `transformers` for a local ONNX model. */
  readonly provider: "hash" | "transformers";
  readonly model: string | null;
  readonly dimensions: number;
  readonly batchSize: number;
}

export interface RerankConfig {
  readonly enabled: boolean;
  readonly provider: "transformers";
  readonly model: string;
  /** How many fused candidates to re-score. Cross-encoders are too slow for more. */
  readonly topK: number;
}

export interface SearchConfig {
  readonly topK: number;
  /** Candidates each signal retrieves, as a multiple of `topK`. */
  readonly candidateMultiplier: number;
  readonly graphHops: number;
  readonly exploreHops: number;
  /** Below this fused score, a result is not evidence and is dropped. */
  readonly minScore: number;
  /**
   * Absolute cosine floor for a dense candidate.
   *
   * Dense search returns the top-k by similarity *however low that is*, so on a
   * small corpus every chunk comes back. Reciprocal Rank Fusion then awards
   * rank-based credit to all of them, and because it normalizes to the best
   * result, an unrelated document can land at a respectable-looking score. No
   * post-fusion threshold fixes that, since the inflation depends on corpus
   * size. The floor therefore belongs here, at candidate generation: a chunk
   * that resembles nothing never becomes a candidate at all.
   *
   * `null` uses the embedding model's own floor, which is almost always right;
   * set a number only to tune one corpus.
   */
  readonly minDenseSimilarity: number | null;
  /**
   * How much of the query the best result must actually contain, 0 to 1.
   *
   * The one threshold that can say "nothing here answers this". Every score in
   * a response is relative -- fusion normalizes its best hit to 1.0 -- so no
   * cutoff on those can tell a hopeless search from a good one, and before this
   * existed a corpus about JWTs answered "published research on protein
   * folding" at a confident 1.0 because one common word was shared.
   *
   * Measured rather than chosen: on the 56-question Japanese gate the real
   * questions cover 0.285 to 0.790 of their query's IDF mass, and eight
   * questions about ramen, cats and quantum chromodynamics cover 0.118 to
   * 0.288. 0.25 clears every real question with margin and turns away three of
   * every four that have no answer here.
   *
   * It is a floor against nothing-matched, not a relevance judge. A question
   * whose words happen to be common in the corpus clears it -- "who won the
   * World Cup" scores 0.288 against Japanese government PDFs, because 国 is
   * everywhere -- and lowering it further would start refusing real questions.
   * Set it to 0 to never abstain.
   */
  readonly minTermCoverage: number;
  readonly snippetChars: number;
  readonly enableGraph: boolean;
  readonly enableDense: boolean;
  readonly enableLexical: boolean;
}

export interface CorpusConfig {
  readonly name: string;
  readonly description: string;
  readonly sources: readonly SourceSpec[];
  readonly embedding: EmbeddingConfig;
  readonly rerank: RerankConfig;
  readonly chunking: ChunkingConfig;
  readonly fusion: FusionConfig;
  readonly graph: GraphRules;
  readonly search: SearchConfig;
}

export const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: "hash",
  model: null,
  dimensions: 256,
  batchSize: 64,
};

/**
 * Reranking defaults to off.
 *
 * It needs a model download and real CPU time, so switching it on has to be a
 * choice. The model is configurable precisely because the best multilingual
 * cross-encoder changes faster than this project will release.
 */
export const DEFAULT_RERANK: RerankConfig = {
  enabled: false,
  provider: "transformers",
  model: "Xenova/bge-reranker-base",
  topK: 20,
};

export const DEFAULT_SEARCH: SearchConfig = {
  topK: 10,
  candidateMultiplier: 6,
  graphHops: 2,
  exploreHops: 3,
  minScore: 0.12,
  minTermCoverage: 0.25,
  minDenseSimilarity: null,
  snippetChars: 320,
  enableGraph: true,
  enableDense: true,
  enableLexical: true,
};

export function defaultCorpusConfig(name: string): CorpusConfig {
  return {
    name,
    description: "",
    sources: [],
    embedding: DEFAULT_EMBEDDING,
    rerank: DEFAULT_RERANK,
    chunking: DEFAULT_CHUNKING,
    fusion: DEFAULT_FUSION,
    graph: DEFAULT_GRAPH_RULES,
    search: DEFAULT_SEARCH,
  };
}
