/**
 * Per-signal scoring for a retrieved chunk.
 *
 * Every signal is reported even when it did not fire (`0`) or did not run
 * (`null`). That distinction is the whole point: an agent can tell "BM25
 * searched and found nothing" from "BM25 was disabled", and a human debugging
 * a bad ranking can see which signal is responsible.
 */

export interface Scores {
  /** Normalized dense (vector) similarity, or null when dense search did not run. */
  readonly dense: number | null;
  /** Normalized BM25 score, or null when lexical search did not run. */
  readonly bm25: number | null;
  /** Normalized graph-proximity score; 0 when the graph did not reach this chunk. */
  readonly graph: number | null;
  /** Cross-encoder score, or null when reranking was not applied. */
  readonly rerank: number | null;
  /** Fused score used for ordering. Always present. */
  readonly final: number;
}

export function createScores(input: Partial<Scores> & { final: number }): Scores {
  return {
    dense: input.dense ?? null,
    bm25: input.bm25 ?? null,
    graph: input.graph ?? null,
    rerank: input.rerank ?? null,
    final: input.final,
  };
}

/**
 * Which signal contributed most to this hit.
 *
 * Used for the human-readable "why" column. `rerank` is excluded because it
 * reorders rather than retrieves: it never explains how a chunk was found.
 */
export function dominantSignal(scores: Scores): "dense" | "bm25" | "graph" | "none" {
  const candidates: Array<["dense" | "bm25" | "graph", number]> = [
    ["dense", scores.dense ?? -1],
    ["bm25", scores.bm25 ?? -1],
    ["graph", scores.graph ?? -1],
  ];
  let best: "dense" | "bm25" | "graph" | "none" = "none";
  let bestValue = 0;
  for (const [name, value] of candidates) {
    if (value > bestValue) {
      bestValue = value;
      best = name;
    }
  }
  return best;
}
