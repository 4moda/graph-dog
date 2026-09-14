import { compareStrings } from "../ordering.ts";
/**
 * Combining dense, BM25 and graph signals into one ranking.
 *
 * Two strategies, because they answer different needs:
 *
 * - `rrf` (default) is Reciprocal Rank Fusion. It uses only *ranks*, so it is
 *   immune to the fact that cosine similarity and BM25 live on incomparable
 *   scales. That is what lets the built-in lexical embedder and a
 *   sentence-transformers model be swapped without retuning any weights.
 * - `weighted` min-max normalizes each signal and takes a weighted sum. It is
 *   sharper when both signals are well calibrated, and it is the escape hatch
 *   for anyone who wants to tune for their own corpus.
 *
 * Either way the per-signal numbers reported in the response are the
 * normalized ones, so "why did this rank here" is answerable from the output
 * alone rather than requiring a rerun with debug logging.
 */

export type FusionStrategy = "rrf" | "weighted";

export interface FusionConfig {
  readonly strategy: FusionStrategy;
  readonly denseWeight: number;
  readonly bm25Weight: number;
  readonly graphWeight: number;
  /** RRF smoothing constant. 60 is the value from the original TREC work. */
  readonly rrfK: number;
}

export const DEFAULT_FUSION: FusionConfig = {
  strategy: "rrf",
  denseWeight: 1,
  bm25Weight: 1,
  graphWeight: 0.35,
  rrfK: 60,
};

export interface FusedScore {
  readonly dense: number | null;
  readonly bm25: number | null;
  readonly graph: number | null;
  readonly final: number;
}

export interface FusionInput {
  /** Ranked dense results, or null when dense retrieval did not run. */
  readonly dense: ReadonlyArray<readonly [string, number]> | null;
  /** Ranked BM25 results, or null when lexical retrieval did not run. */
  readonly bm25: ReadonlyArray<readonly [string, number]> | null;
  /** Graph-proximity scores, or null when graph expansion did not run. */
  readonly graph: ReadonlyMap<string, number> | null;
}

/**
 * Min-max normalize to `[0, 1]`.
 *
 * A single result, or a set of identical scores, maps to 1: with nothing to
 * compare against, "as good as it gets here" is the honest reading, and
 * mapping to 0 would wrongly suppress a sole exact match.
 */
export function normalize(scores: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (scores.size === 0) return out;
  const values = [...scores.values()];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  for (const [key, value] of scores) {
    out.set(key, span < 1e-12 ? 1 : (value - low) / span);
  }
  return out;
}

/** Rank position (1-based) of each key, ties broken on key for determinism. */
function rankPositions(entries: ReadonlyArray<readonly [string, number]>): Map<string, number> {
  const sorted = [...entries].sort((left, right) =>
    right[1] === left[1] ? compareStrings(left[0], right[0]) : right[1] - left[1],
  );
  const out = new Map<string, number>();
  sorted.forEach(([key], index) => out.set(key, index + 1));
  return out;
}

function toMap(entries: ReadonlyArray<readonly [string, number]> | null): Map<string, number> {
  return new Map(entries ?? []);
}

/**
 * Fuse ranked signals keyed by chunk id.
 *
 * Per-signal values are the normalized ones, or `null` when that signal did
 * not run at all. Ordering is left to the caller, which resolves ties on
 * chunk id.
 */
export function fuse(input: FusionInput, config: FusionConfig = DEFAULT_FUSION): Map<string, FusedScore> {
  const denseRan = input.dense !== null;
  const bm25Ran = input.bm25 !== null;
  const graphRan = input.graph !== null;

  const denseScores = toMap(input.dense);
  const bm25Scores = toMap(input.bm25);
  const graphScores = new Map(input.graph ?? []);

  const denseNorm = normalize(denseScores);
  const bm25Norm = normalize(bm25Scores);
  const graphNorm = normalize(graphScores);

  const keys = new Set<string>([...denseScores.keys(), ...bm25Scores.keys(), ...graphScores.keys()]);
  const out = new Map<string, FusedScore>();

  const build = (key: string, final: number): FusedScore => ({
    dense: denseRan ? (denseNorm.get(key) ?? 0) : null,
    bm25: bm25Ran ? (bm25Norm.get(key) ?? 0) : null,
    graph: graphRan ? (graphNorm.get(key) ?? 0) : null,
    final,
  });

  if (config.strategy === "weighted") {
    const total = config.denseWeight + config.bm25Weight + config.graphWeight;
    for (const key of keys) {
      const sum =
        config.denseWeight * (denseNorm.get(key) ?? 0) +
        config.bm25Weight * (bm25Norm.get(key) ?? 0) +
        config.graphWeight * (graphNorm.get(key) ?? 0);
      out.set(key, build(key, total > 0 ? sum / total : 0));
    }
    return out;
  }

  const denseRank = rankPositions([...denseScores.entries()]);
  const bm25Rank = rankPositions([...bm25Scores.entries()]);
  const graphRank = rankPositions([...graphScores.entries()]);

  const raw = new Map<string, number>();
  for (const key of keys) {
    let score = 0;
    const dense = denseRank.get(key);
    if (dense !== undefined) score += config.denseWeight / (config.rrfK + dense);
    const bm25 = bm25Rank.get(key);
    if (bm25 !== undefined) score += config.bm25Weight / (config.rrfK + bm25);
    const graph = graphRank.get(key);
    if (graph !== undefined) score += config.graphWeight / (config.rrfK + graph);
    raw.set(key, score);
  }

  // Scale so the best result is 1. A raw RRF value is meaningless to a caller,
  // but "how close to the top hit is this" is directly actionable, and it lets
  // one relevance threshold work across corpora of any size.
  const best = Math.max(0, ...raw.values());
  for (const key of keys) {
    out.set(key, build(key, best > 0 ? (raw.get(key) ?? 0) / best : 0));
  }
  return out;
}

/** Order fused results, highest first, ties broken on chunk id. */
export function rankFused(fused: ReadonlyMap<string, FusedScore>): Array<[string, FusedScore]> {
  return [...fused.entries()].sort((left, right) =>
    right[1].final === left[1].final
      ? compareStrings(left[0], right[0])
      : right[1].final - left[1].final,
  );
}
