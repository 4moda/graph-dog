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
import { rankScores, scoreBm25, termCoverage } from "../../domain/service/bm25.ts";
import { fuse, rankFused } from "../../domain/service/fusion.ts";
import { expandGraph } from "../../domain/service/graph-expansion.ts";
import { bestSnippet } from "../../domain/service/snippet.ts";
import { termFrequencies, tokenize } from "../../domain/service/tokenizer.ts";
import type { CorpusConfig } from "../config.ts";
import { WarningCode, type CorpusSearchSummaryDto } from "../dto/contracts.ts";
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
  /** Override how much of the query the best result must contain; 0 never abstains. */
  readonly minTermCoverage?: number;
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
  /** One entry per corpus considered. A single search reports one. */
  readonly corpora: readonly CorpusSearchSummaryDto[];
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

  // A non-semantic embedder hashes the same tokens BM25 already weighs, so
  // fusing its vectors in is not a second opinion -- it is one opinion voting
  // twice, and on every judged suite it ranks worse than BM25 alone. The
  // vectors still earn their keep at build time, where they draw the graph's
  // `similar` edges between documents that share wording.
  const denseRanks = search.enableDense && embedding.semantic;
  const offDenseReason = search.enableDense ? "off:lexical-embedder" : "off";

  let dense: Array<[string, number]> | null = null;
  if (denseRanks && store.vectors.size() > 0) {
    const queryVector = await embedding.embedQuery(options.query);
    // Filtered by absolute similarity, not just truncated by rank: see the note
    // on `minDenseSimilarity`. Without this, everything in a small corpus is a
    // candidate and fusion hands unrelated documents a plausible score.
    dense = store.vectors
      .search(queryVector, candidateCount)
      .filter(([, similarity]) => similarity >= denseFloor);
  }

  let lexical: Array<[string, number]> | null = null;
  // How much of the query each chunk actually contains, which unlike every
  // score below survives normalization and means the same thing on any corpus.
  let coverage = new Map<string, number>();
  if (search.enableLexical && queryTerms.length > 0) {
    const postings = store.lexical.postingsFor([...new Set(queryTerms)]);
    const queryFrequencies = termFrequencies(options.query);
    const statistics = store.lexical.statistics();
    const scores = scoreBm25(postings, queryFrequencies, statistics);
    coverage = termCoverage(postings, queryFrequencies, statistics);
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
      graphScores = representativeChunks(expansion.scores, owner, dense, lexical);
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

  let accepted = ranked.filter(([, score]) => score.final >= minScore).slice(0, topK);
  const topCoverage = accepted.length === 0 ? 0 : Math.max(...accepted.map(([id]) => coverage.get(id) ?? 0));

  // The one check that can say "nothing here answers this". Every score above
  // is relative -- fusion normalizes its best hit to 1.0 -- so the top result
  // of a hopeless search is indistinguishable from the top result of a good
  // one. Coverage is absolute, and this is where it earns its keep.
  //
  // It speaks only for BM25, though. Each signal gets the floor that suits it:
  // coverage for lexical, `minDenseSimilarity` for dense, applied at candidate
  // generation. A paraphrase a semantic model found has every right to share no
  // words with the query -- that is what it is for -- so a result that dense
  // retrieval put here is never refused for covering too little of it.
  const minCoverage = options.minTermCoverage ?? search.minTermCoverage;
  const denseFound = new Set((dense ?? []).map(([chunkId]) => chunkId));
  const restsOnLexical = accepted.every(([chunkId]) => !denseFound.has(chunkId));
  const abstained =
    lexical !== null &&
    minCoverage > 0 &&
    accepted.length > 0 &&
    restsOnLexical &&
    topCoverage < minCoverage;
  if (abstained) accepted = [];
  const chunkRows = store.chunks.getMany(accepted.map(([chunkId]) => chunkId));

  const hits: HitView[] = [];
  for (const [chunkId, score] of accepted) {
    const chunk = chunkRows.get(chunkId);
    if (chunk === undefined) continue;
    const document = store.documents.get(chunk.ref);
    hits.push({
      corpus: config.name,
      corpusRank: hits.length + 1,
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
      message: abstained
        ? `nothing in this corpus covers enough of the query: the best match contains ` +
          `${(topCoverage * 100).toFixed(0)}% of what was asked for, against a floor of ` +
          `${(minCoverage * 100).toFixed(0)}%`
        : ranked.length === 0
          ? "no document matched this query"
          : `no result reached the relevance threshold of ${minScore}`,
      details: {
        candidates_considered: ranked.length,
        min_score: minScore,
        term_coverage: Math.round(topCoverage * 1000) / 1000,
        min_term_coverage: minCoverage,
      },
    });
  }

  if (freshness.status === "stale") {
    warnings.push({
      code: WarningCode.STALE_CORPUS,
      message: `corpus may be out of date: ${freshness.reason ?? "sources have changed"}`,
      details: { built_at: freshness.builtAt },
    });
  }

  if (!embedding.semantic) {
    warnings.push({
      code: WarningCode.LEXICAL_EMBEDDING,
      message:
        "this corpus uses the built-in lexical embedder, which matches wording rather " +
        "than meaning; its vectors are not ranked against the query (BM25 already " +
        "weighs those words) and serve only the graph's similarity edges; configure a " +
        "semantic embedding model for paraphrase recall",
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
    corpora: [
      {
        name: config.name,
        scope: "",
        embedding_id: embedding.id,
        hits: hits.length,
        searched: true,
        skipped_reason: null,
      },
    ],
    freshness,
    hits,
    suggestedQueries: suggestQueries(hits, store, options.query),
    strategy: {
      fusion: config.fusion.strategy,
      dense: dense !== null ? embedding.id : denseRanks ? "off" : offDenseReason,
      lexical: lexical === null ? "off" : "bm25",
      graph: graphScores === null ? "off" : `expansion:${hops}hop`,
      rerank: reranked ? config.rerank.model : "off",
      min_score: minScore,
      min_term_coverage: minCoverage,
      min_dense_similarity: denseFloor,
      top_k: topK,
    },
    stats: {
      dense_candidates: dense?.length ?? 0,
      lexical_candidates: lexical?.length ?? 0,
      graph_candidates: graphScores?.size ?? 0,
      fused_candidates: ranked.length,
      top_term_coverage: Math.round(topCoverage * 1000) / 1000,
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

/**
 * Give each graph-reached document's score to exactly one of its chunks.
 *
 * The graph's claim is about a *document*: "this file is connected to what you
 * found". Handing that score to every chunk of the file turns one claim into
 * forty tied candidates, and RRF then breaks those ties on chunk id -- which
 * is to say arbitrarily. On a small corpus that is enough to push a chunk with
 * no textual evidence above one that matched the query exactly, which is the
 * "graph-augmented search feels arbitrary" failure the seed limit above is
 * also guarding against. This was caught by the evaluation harness: a query
 * naming an exact field name was landing at rank 4.
 *
 * The representative is the document's best chunk under the direct signals, so
 * the graph amplifies real evidence where there is any, and its first chunk
 * otherwise, so a document the query never matched can still be introduced by
 * its opening.
 */
function representativeChunks(
  documentScores: ReadonlyMap<string, number>,
  owner: ReadonlyMap<string, string>,
  dense: ReadonlyArray<readonly [string, number]> | null,
  lexical: ReadonlyArray<readonly [string, number]> | null,
): Map<string, number> {
  const out = new Map<string, number>();
  if (documentScores.size === 0) return out;

  // Best direct rank per chunk; lower is better, and a chunk no signal ranked
  // is worse than any that one did.
  const directRank = new Map<string, number>();
  const note = (entries: ReadonlyArray<readonly [string, number]> | null): void => {
    entries?.forEach(([chunkId], index) => {
      const existing = directRank.get(chunkId);
      if (existing === undefined || index < existing) directRank.set(chunkId, index);
    });
  };
  note(dense);
  note(lexical);

  const best = new Map<string, string>();
  for (const [chunkId, ref] of owner) {
    if (!documentScores.has(ref)) continue;
    const incumbent = best.get(ref);
    if (incumbent === undefined || prefers(chunkId, incumbent, directRank)) best.set(ref, chunkId);
  }

  for (const [ref, chunkId] of best) {
    const score = documentScores.get(ref);
    if (score !== undefined) out.set(chunkId, score);
  }
  return out;
}

/** Whether `candidate` should represent its document instead of `incumbent`. */
function prefers(
  candidate: string,
  incumbent: string,
  directRank: ReadonlyMap<string, number>,
): boolean {
  const left = directRank.get(candidate) ?? Number.POSITIVE_INFINITY;
  const right = directRank.get(incumbent) ?? Number.POSITIVE_INFINITY;
  // Ties fall back to chunk id, which orders by ordinal within a document and
  // keeps the choice deterministic across runs and machines.
  return left === right ? compareStrings(candidate, incumbent) < 0 : left < right;
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
