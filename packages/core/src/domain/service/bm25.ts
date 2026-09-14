import { compareStrings } from "../ordering.ts";
/**
 * Okapi BM25 scoring.
 *
 * Pure arithmetic over posting statistics that the storage layer supplies. It
 * is implemented here rather than pulled from a library for three reasons: the
 * whole index is persisted (so a query never re-tokenizes the corpus, which the
 * predecessor did on every search), scoring runs over the *entire* corpus
 * rather than a dense-retrieved shortlist, and there is no dependency to pin.
 *
 * Scoring the whole corpus is the substantive change. Previously BM25 could
 * only re-rank what the vector search had already found, so an exact keyword
 * match the embedder missed was unreachable no matter how well it matched.
 * Here the two signals are genuinely independent, which is what gives fusion
 * something to fuse.
 */

export interface Bm25Params {
  /** Term-frequency saturation. Higher means repeated terms keep helping. */
  readonly k1: number;
  /** Length normalization, 0 (off) to 1 (full). */
  readonly b: number;
}

export const DEFAULT_BM25: Bm25Params = { k1: 1.2, b: 0.75 };

/** One posting: a term occurring in a chunk, with the statistics to score it. */
export interface Posting {
  readonly term: string;
  readonly chunkId: string;
  /** Occurrences of `term` in this chunk. */
  readonly tf: number;
  /** Number of chunks in the corpus containing `term`. */
  readonly df: number;
  /** Length of this chunk in index terms. */
  readonly tokenCount: number;
}

export interface CorpusStatistics {
  /** Number of chunks in the corpus. */
  readonly chunkCount: number;
  /** Mean chunk length in index terms. */
  readonly averageTokenCount: number;
}

/**
 * Inverse document frequency, Robertson/Sparck-Jones with the `+1` guard.
 *
 * The guard keeps a term that appears in every chunk at exactly 0 rather than
 * going negative, which would otherwise let a ubiquitous word *penalise* the
 * chunks containing it.
 */
export function inverseDocumentFrequency(chunkCount: number, documentFrequency: number): number {
  const df = Math.max(1, documentFrequency);
  return Math.log(1 + (chunkCount - df + 0.5) / (df + 0.5));
}

/**
 * Score every chunk touched by the query terms.
 *
 * `queryTermFrequency` weights repeated query terms, matching the standard
 * multi-term BM25 formulation: asking for "token token" really does prefer
 * chunks dense in that term.
 */
export function scoreBm25(
  postings: readonly Posting[],
  queryTermFrequency: ReadonlyMap<string, number>,
  corpus: CorpusStatistics,
  params: Bm25Params = DEFAULT_BM25,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (corpus.chunkCount <= 0 || corpus.averageTokenCount <= 0) return scores;

  for (const posting of postings) {
    const queryWeight = queryTermFrequency.get(posting.term) ?? 0;
    if (queryWeight <= 0) continue;

    const idf = inverseDocumentFrequency(corpus.chunkCount, posting.df);
    const length = Math.max(1, posting.tokenCount);
    const denominator =
      posting.tf + params.k1 * (1 - params.b + (params.b * length) / corpus.averageTokenCount);
    if (denominator <= 0) continue;

    const contribution = (idf * (posting.tf * (params.k1 + 1))) / denominator;
    scores.set(posting.chunkId, (scores.get(posting.chunkId) ?? 0) + contribution * queryWeight);
  }
  return scores;
}

/**
 * Rank scored chunks, highest first.
 *
 * Ties break on chunk id so that repeating a query returns the same order.
 * Without that, two equally scored chunks could swap places between runs and
 * make golden tests and evaluation metrics flap.
 */
export function rankScores(scores: ReadonlyMap<string, number>, topK: number): Array<[string, number]> {
  const ranked = [...scores.entries()].sort((left, right) =>
    right[1] === left[1] ? compareStrings(left[0], right[0]) : right[1] - left[1],
  );
  return topK >= 0 ? ranked.slice(0, topK) : ranked;
}
