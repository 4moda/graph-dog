/**
 * The query pipeline.
 *
 * Query -> dense retrieval + BM25 retrieval (independently, over the whole
 * corpus) -> graph expansion from the best direct hits -> fusion -> optional
 * rerank -> evidence assembly.
 *
 * Two properties this owes the caller:
 *
 * - **Honesty.** When nothing clears the relevance threshold it says so, with a
 *   warning and a dedicated exit code, instead of returning the least-bad rows
 *   as though they were answers.
 * - **Explainability.** Every hit reports what each signal contributed and, for
 *   graph-reached hits, the chain of edges that found it.
 */

import { createScores } from "../../domain/model/scores.ts";
import { documentNodeId, type GraphEdge } from "../../domain/model/graph.ts";
import type { Freshness } from "../../domain/model/freshness.ts";
import { rankScores, scoreBm25 } from "../../domain/service/bm25.ts";
import { fuse, rankFused } from "../../domain/service/fusion.ts";
import { expandGraph } from "../../domain/service/graph-expansion.ts";
import { bestSnippet } from "../../domain/service/snippet.ts";
import { termFrequencies, tokenize } from "../../domain/service/tokenizer.ts";
import type { CorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { HitView, Warning } from "../dto/mappers.ts";
import type { CorpusStore } from "../ports/repositories.ts";
import type { EmbeddingModel, Reranker } from "../ports/models.ts";
import type { Logger } from "../ports/system.ts";
import { SILENT_LOGGER } from "../ports/system.ts";
import { compareStrings } from "../../domain/ordering.ts";

export interface SearchOptions {
  readonly query: string;
  readonly topK?: number;
  readonly hops?: number;
  readonly minScore?: number;
  /** Force reranking on or off for this query, overriding the corpus default. */
  readonly rerank?: boolean;
  /** Restrict results to refs under these prefixes, e.g. a single source id. */
  readonly filterPrefixes?: readonly string[];
}

export interface SearchDependencies {
  readonly store: CorpusStore;
  readonly config: CorpusConfig;
  readonly embedding: EmbeddingModel;
  readonly freshness: Freshness;
  readonly reranker?: Reranker | null;
  readonly logger?: Logger;
}

export interface SearchOutcome {
  readonly query: string;
  readonly corpus: string;
  readonly freshness: Freshness;
  readonly hits: HitView[];
  readonly suggestedQueries: string[];
  readonly strategy: Record<string, unknown>;
  readonly stats: Record<string, unknown>;
  readonly warnings: Warning[];
  /** True when nothing cleared the threshold; the caller maps this to an exit code. */
  readonly noEvidence: boolean;
  /** Refs of the top results, so `explore` can fetch their neighbourhood. */
  readonly topRefs: string[];
}

export async function searchCorpus(
  options: SearchOptions,
  dependencies: SearchDependencies,
): Promise<SearchOutcome> {
  const { store, config, embedding, freshness } = dependencies;
  const logger = dependencies.logger ?? SILENT_LOGGER;
  const search = config.search;

  const topK = options.topK ?? search.topK;
  const minScore = options.minScore ?? search.minScore;
  const hops = options.hops ?? search.graphHops;
  const candidateCount = Math.max(topK * search.candidateMultiplier, topK);
  const warnings: Warning[] = [];

  // `null` defers to the model, which knows its own similarity scale.
  const denseFloor = search.minDenseSimilarity ?? embedding.minUsefulSimilarity;

  const startedAt = Date.now();
  const queryTerms = tokenize(options.query);

  // --- independent retrieval ------------------------------------------------

  let dense: Array<[string, number]> | null = null;
  if (search.enableDense && store.vectors.size() > 0) {
    const queryVector = await embedding.embedQuery(options.query);
    // Filtered by absolute similarity, not just truncated by rank: see the note
    // on `minDenseSimilarity`. Without this, everything in a small corpus is a
    // candidate and fusion hands unrelated documents a plausible score.
    dense = store.vectors
      .search(queryVector, candidateCount)
      .filter(([, similarity]) => similarity >= denseFloor);
  }

  let lexical: Array<[string, number]> | null = null;
  if (search.enableLexical && queryTerms.length > 0) {
    const postings = store.lexical.postingsFor([...new Set(queryTerms)]);
    const scores = scoreBm25(postings, termFrequencies(options.query), store.lexical.statistics());
    lexical = rankScores(scores, candidateCount);
  }

  // --- graph expansion from the strongest direct hits ------------------------

  const owner = store.chunks.ownerMap();
  let graphScores: Map<string, number> | null = null;
  let graphPaths = new Map<string, GraphEdge[]>();

  if (search.enableGraph && hops > 0) {
    const seeds = seedDocuments(dense, lexical, owner);
    if (seeds.size > 0) {
      const expansion = expandGraph(
        seeds,
        (nodeIds) => store.graph.outgoing(nodeIds),
        { hops, maxNodes: candidateCount, minScore: 0.01 },
      );
      graphPaths = expansion.paths;
      graphScores = spreadToChunks(expansion.scores, owner);
    } else {
      graphScores = new Map();
    }
  }

  // --- fusion ---------------------------------------------------------------

  const fused = fuse({ dense, bm25: lexical, graph: graphScores }, config.fusion);
  let ranked = rankFused(fused);

  if (options.filterPrefixes && options.filterPrefixes.length > 0) {
    const prefixes = options.filterPrefixes;
    ranked = ranked.filter(([chunkId]) => {
      const ref = owner.get(chunkId);
      return ref !== undefined && prefixes.some((prefix) => ref.startsWith(prefix));
    });
  }

  // --- optional rerank ------------------------------------------------------

  const rerankRequested = options.rerank ?? config.rerank.enabled;
  const rerankScores = new Map<string, number>();
  let reranked = false;

  if (rerankRequested && ranked.length > 0) {
    const reranker = dependencies.reranker ?? null;
    if (reranker === null) {
      warnings.push({
        code: WarningCode.RERANK_UNAVAILABLE,
        message:
          "reranking was requested but no reranker is available; results are ordered by fusion only",
        details: { model: config.rerank.model },
      });
    } else {
      const shortlist = ranked.slice(0, Math.max(topK, config.rerank.topK));
      const chunks = store.chunks.getMany(shortlist.map(([chunkId]) => chunkId));
      const candidates = shortlist
        .map(([chunkId]) => {
          const chunk = chunks.get(chunkId);
          return chunk === undefined ? null : { id: chunkId, text: chunk.text };
        })
        .filter((candidate): candidate is { id: string; text: string } => candidate !== null);

      try {
        for (const result of await reranker.rerank(options.query, candidates)) {
          rerankScores.set(result.id, result.score);
        }
        reranked = true;
        // Reranked candidates move to the front, in the cross-encoder's order;
        // everything it did not see keeps its fused order behind them.
        const seen = new Set(rerankScores.keys());
        const rescored = ranked
          .filter(([chunkId]) => seen.has(chunkId))
          .sort((left, right) => (rerankScores.get(right[0]) ?? 0) - (rerankScores.get(left[0]) ?? 0));
        ranked = [...rescored, ...ranked.filter(([chunkId]) => !seen.has(chunkId))];
      } catch (error) {
        logger.log("warn", "reranker failed; falling back to fusion order", {
          error: String(error),
        });
        warnings.push({
          code: WarningCode.RERANK_UNAVAILABLE,
          message: `reranker failed: ${String(error)}; results are ordered by fusion only`,
          details: { model: config.rerank.model },
        });
      }
    }
  }

  // --- evidence assembly ----------------------------------------------------

  const accepted = ranked.filter(([, score]) => score.final >= minScore).slice(0, topK);
  const chunkRows = store.chunks.getMany(accepted.map(([chunkId]) => chunkId));

  const hits: HitView[] = [];
  for (const [chunkId, score] of accepted) {
    const chunk = chunkRows.get(chunkId);
    if (chunk === undefined) continue;
    const document = store.documents.get(chunk.ref);
    hits.push({
      ref: chunk.ref,
      chunkId,
      title: document?.title ?? chunk.ref,
      headingPath: chunk.headingPath,
      snippet: bestSnippet(chunk.text, options.query, search.snippetChars),
      location: chunk.location,
      scores: createScores({
        dense: score.dense,
        bm25: score.bm25,
        graph: score.graph,
        rerank: rerankScores.get(chunkId) ?? null,
        final: score.final,
      }),
      sourceRevision: document?.revision ?? null,
      graphPath: graphPaths.get(chunk.ref) ?? [],
      tags: document?.tags ?? [],
    });
  }

  const noEvidence = hits.length === 0;
  if (noEvidence) {
    warnings.push({
      code: WarningCode.NO_SUFFICIENT_EVIDENCE,
      message:
        ranked.length === 0
          ? "no document matched this query"
          : `no result reached the relevance threshold of ${minScore}`,
      details: { candidates_considered: ranked.length, min_score: minScore },
    });
  }

  if (freshness.status === "stale") {
    warnings.push({
      code: WarningCode.STALE_CORPUS,
      message: `corpus may be out of date: ${freshness.reason ?? "sources have changed"}`,
      details: { built_at: freshness.builtAt },
    });
  }

  if (!embedding.semantic && hits.length > 0) {
    warnings.push({
      code: WarningCode.LEXICAL_EMBEDDING,
      message:
        "this corpus uses the built-in lexical embedder, which matches wording rather " +
        "than meaning; configure a semantic embedding model for paraphrase recall",
      details: { embedding_id: embedding.id },
    });
  }

  const failureCount = store.meta.listFailures().length;
  if (failureCount > 0) {
    warnings.push({
      code: WarningCode.PARTIAL_INDEX,
      message: `${failureCount} file(s) failed to index; results may be incomplete`,
      details: { failures: failureCount },
    });
  }

  return {
    query: options.query,
    corpus: config.name,
    freshness,
    hits,
    suggestedQueries: suggestQueries(hits, store, options.query),
    strategy: {
      fusion: config.fusion.strategy,
      dense: dense === null ? "off" : embedding.id,
      lexical: lexical === null ? "off" : "bm25",
      graph: graphScores === null ? "off" : `expansion:${hops}hop`,
      rerank: reranked ? config.rerank.model : "off",
      min_score: minScore,
      min_dense_similarity: denseFloor,
      top_k: topK,
    },
    stats: {
      dense_candidates: dense?.length ?? 0,
      lexical_candidates: lexical?.length ?? 0,
      graph_candidates: graphScores?.size ?? 0,
      fused_candidates: ranked.length,
      returned: hits.length,
      corpus_chunks: store.chunks.count(),
      corpus_documents: store.documents.count(),
      elapsed_ms: Date.now() - startedAt,
    },
    warnings,
    noEvidence,
    topRefs: [...new Set(hits.map((hit) => hit.ref))],
  };
}

/**
 * Pick the documents worth expanding from.
 *
 * Only the strongest few direct hits seed the graph. Seeding from everything
 * would let graph proximity swamp the ranking, which is the failure mode that
 * makes graph-augmented search feel arbitrary.
 */
function seedDocuments(
  dense: ReadonlyArray<readonly [string, number]> | null,
  lexical: ReadonlyArray<readonly [string, number]> | null,
  owner: ReadonlyMap<string, string>,
  limit = 3,
): Map<string, number> {
  const seeds = new Map<string, number>();
  const consider = (entries: ReadonlyArray<readonly [string, number]> | null): void => {
    if (entries === null) return;
    let taken = 0;
    for (const [chunkId] of entries) {
      const ref = owner.get(chunkId);
      if (ref === undefined) continue;
      const nodeId = documentNodeId(ref);
      if (!seeds.has(nodeId)) seeds.set(nodeId, 1);
      taken += 1;
      if (taken >= limit) break;
    }
  };
  consider(dense);
  consider(lexical);
  return seeds;
}

/** Attribute a document's graph score to each of its chunks. */
function spreadToChunks(
  documentScores: ReadonlyMap<string, number>,
  owner: ReadonlyMap<string, string>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (documentScores.size === 0) return out;
  for (const [chunkId, ref] of owner) {
    const score = documentScores.get(ref);
    if (score !== undefined) out.set(chunkId, score);
  }
  return out;
}

/**
 * Suggest follow-up queries from the tags and headings of what was found.
 *
 * These come from corpus structure rather than a language model, so they are
 * guaranteed to be terms that actually occur in the indexed documents -- a
 * suggestion that returns nothing is worse than no suggestion.
 */
function suggestQueries(hits: readonly HitView[], store: CorpusStore, query: string): string[] {
  const asked = new Set(tokenize(query));
  const counts = new Map<string, number>();

  const offer = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed.length < 2 || trimmed.length > 60) return;
    if (tokenize(trimmed).every((term) => asked.has(term))) return;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  };

  for (const hit of hits) {
    for (const tag of hit.tags) offer(tag);
    const leaf = hit.headingPath.split(" > ").pop();
    if (leaf !== undefined) offer(leaf);
  }

  // Also offer the titles of documents the graph connects to the top hit, which
  // is how a caller discovers the neighbourhood without running `explore`.
  const top = hits[0];
  if (top !== undefined) {
    const { nodes } = store.graph.neighborhood([top.ref], 12);
    for (const node of nodes) {
      if (node.kind === "tag") offer(node.label);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))
    .slice(0, 6)
    .map(([term]) => term);
}
