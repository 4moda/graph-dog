/**
 * Searching several corpora at once.
 *
 * Each corpus is searched independently through the *same* pipeline, so every
 * result is internally valid, and the per-corpus lists are then merged by rank.
 *
 * Merging by rank rather than by score is the whole design. `searchCorpus`
 * normalizes its fused scores so the best hit in that corpus is 1.0 — which
 * means a weak corpus's best hit and a strong corpus's best hit both score 1.0.
 * Interleaving those numbers would systematically promote whichever corpus had
 * the least to offer. Ranks carry no such distortion: rank 1 means "the best
 * this corpus had", which is exactly what Reciprocal Rank Fusion is built to
 * combine.
 *
 * Two honesty obligations come with that:
 *
 * - **Mixed embeddings are flagged.** Two corpora built with different models
 *   produce ranks of different quality, and a caller comparing them should know.
 * - **A skipped corpus is reported, not dropped.** One unbuilt or incompatible
 *   corpus must not silently shrink the search space into something that looks
 *   like a complete answer.
 */

import { compareStrings } from "../../domain/ordering.ts";
import type { Freshness } from "../../domain/model/freshness.ts";
import { createScores } from "../../domain/model/scores.ts";
import { toGraphDogError } from "../../domain/errors.ts";
import type { CorpusSearchSummaryDto } from "../dto/contracts.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { HitView, Warning } from "../dto/mappers.ts";
import type { Logger } from "../ports/system.ts";
import { SILENT_LOGGER } from "../ports/system.ts";
import {
  searchCorpus,
  type SearchDependencies,
  type SearchOptions,
  type SearchOutcome,
} from "./search-corpus.ts";

/** RRF smoothing constant for the cross-corpus merge. */
const CROSS_CORPUS_RRF_K = 60;

/** One corpus to search, with everything needed to search it. */
export interface CorpusTarget {
  readonly name: string;
  readonly scope: string;
  readonly dependencies: SearchDependencies;
  /**
   * Set when the corpus cannot be searched. It is still reported, so the caller
   * sees that the search space was smaller than they asked for.
   */
  readonly unavailable?: string | null;
}

export interface SearchCorporaDependencies {
  readonly targets: readonly CorpusTarget[];
  readonly logger?: Logger;
}

export interface MultiCorpusOutcome extends Omit<SearchOutcome, "topRefs"> {
  /** Refs of the top results, keyed by the corpus they came from. */
  readonly topRefsByCorpus: ReadonlyMap<string, string[]>;
}

export async function searchCorpora(
  options: SearchOptions,
  dependencies: SearchCorporaDependencies,
): Promise<MultiCorpusOutcome> {
  const logger = dependencies.logger ?? SILENT_LOGGER;
  const available = dependencies.targets.filter((target) => !target.unavailable);

  // One corpus is not a special case worth a second code path, but it is worth
  // avoiding the cross-corpus re-ranking: with nothing to merge against, the
  // fused scores would be flattened to reciprocal ranks for no benefit, and the
  // caller would lose the per-signal calibration.
  if (available.length === 1 && dependencies.targets.length === 1) {
    const only = available[0] as CorpusTarget;
    const outcome = await searchCorpus(options, only.dependencies);
    return {
      ...outcome,
      corpora: [{ ...(outcome.corpora[0] as CorpusSearchSummaryDto), scope: only.scope }],
      topRefsByCorpus: new Map([[only.name, outcome.topRefs]]),
    };
  }

  const warnings: Warning[] = [];
  const summaries: CorpusSearchSummaryDto[] = [];
  const perCorpus: Array<{ target: CorpusTarget; outcome: SearchOutcome }> = [];

  for (const target of dependencies.targets) {
    if (target.unavailable) {
      summaries.push({
        name: target.name,
        scope: target.scope,
        embedding_id: null,
        hits: 0,
        searched: false,
        skipped_reason: target.unavailable,
      });
      warnings.push({
        code: WarningCode.CORPUS_SKIPPED,
        message: `corpus "${target.name}" was not searched: ${target.unavailable}`,
        details: { corpus: target.name },
      });
      continue;
    }

    try {
      // Each corpus returns a full page of candidates: a corpus whose best hit
      // ranks tenth overall still needs to have produced that hit.
      const outcome = await searchCorpus(options, target.dependencies);
      perCorpus.push({ target, outcome });
    } catch (error) {
      const failure = toGraphDogError(error);
      logger.log("warn", "corpus search failed", { corpus: target.name, error: failure.message });
      summaries.push({
        name: target.name,
        scope: target.scope,
        embedding_id: null,
        hits: 0,
        searched: false,
        skipped_reason: failure.message,
      });
      warnings.push({
        code: WarningCode.CORPUS_SKIPPED,
        message: `corpus "${target.name}" was not searched: ${failure.message}`,
        details: { corpus: target.name, code: failure.code },
      });
    }
  }

  // --- merge by rank --------------------------------------------------------

  const topK = options.topK ?? defaultTopK(perCorpus);
  const merged = mergeByRank(perCorpus, topK);

  // --- summaries and warnings ----------------------------------------------

  const hitsPerCorpus = new Map<string, number>();
  for (const hit of merged) {
    hitsPerCorpus.set(hit.corpus, (hitsPerCorpus.get(hit.corpus) ?? 0) + 1);
  }

  for (const { target } of perCorpus) {
    summaries.push({
      name: target.name,
      scope: target.scope,
      // Read from the model rather than from the strategy string: the latter
      // reports "off" when a corpus has no vectors, which would make two
      // different models look identical.
      embedding_id: target.dependencies.embedding.id,
      hits: hitsPerCorpus.get(target.name) ?? 0,
      searched: true,
      skipped_reason: null,
    });
  }
  summaries.sort((left, right) => compareStrings(left.name, right.name));

  const embeddings = new Set(perCorpus.map(({ target }) => target.dependencies.embedding.id));
  if (embeddings.size > 1) {
    warnings.push({
      code: WarningCode.MIXED_EMBEDDINGS,
      message:
        "these corpora were built with different embedding models; results are merged by " +
        "rank, but a rank from one corpus is not the same quality of evidence as a rank " +
        "from another",
      details: { embeddings: [...embeddings].sort(compareStrings) },
    });
  }

  warnings.push(...collectCorpusWarnings(perCorpus));

  const noEvidence = merged.length === 0;
  if (noEvidence) {
    warnings.unshift({
      code: WarningCode.NO_SUFFICIENT_EVIDENCE,
      message:
        perCorpus.length === 0
          ? "no corpus could be searched"
          : `no result reached the relevance threshold in any of ${perCorpus.length} corpus/corpora`,
      details: { corpora: perCorpus.map(({ target }) => target.name) },
    });
  }

  const topRefsByCorpus = new Map<string, string[]>();
  for (const hit of merged) {
    const existing = topRefsByCorpus.get(hit.corpus) ?? [];
    if (!existing.includes(hit.ref)) existing.push(hit.ref);
    topRefsByCorpus.set(hit.corpus, existing);
  }

  return {
    query: options.query,
    corpus: dependencies.targets.map((target) => target.name).join(", "),
    corpora: summaries,
    freshness: worstFreshness(perCorpus.map(({ outcome }) => outcome.freshness)),
    hits: merged,
    suggestedQueries: mergeSuggestions(perCorpus.map(({ outcome }) => outcome.suggestedQueries)),
    strategy: {
      fusion: "rrf-cross-corpus",
      corpora: perCorpus.length,
      rrf_k: CROSS_CORPUS_RRF_K,
      top_k: topK,
      per_corpus: Object.fromEntries(
        perCorpus.map(({ target, outcome }) => [target.name, outcome.strategy]),
      ),
    },
    stats: {
      corpora_searched: perCorpus.length,
      corpora_skipped: dependencies.targets.length - perCorpus.length,
      candidates: perCorpus.reduce((sum, { outcome }) => sum + outcome.hits.length, 0),
      returned: merged.length,
      elapsed_ms: perCorpus.reduce(
        (sum, { outcome }) => sum + Number(outcome.stats["elapsed_ms"] ?? 0),
        0,
      ),
    },
    warnings,
    noEvidence,
    topRefsByCorpus,
  };
}

/**
 * Carry through the individual searches' warnings, collapsing repeats.
 *
 * The same generic advisory from five corpora -- "this corpus uses the lexical
 * embedder" -- is one fact about five corpora, not five facts. Emitting it five
 * times buries the warnings that differ. Distinct messages stay separate and
 * keep their corpus prefix, because those really are different facts.
 */
function collectCorpusWarnings(
  perCorpus: ReadonlyArray<{ target: CorpusTarget; outcome: SearchOutcome }>,
): Warning[] {
  const grouped = new Map<string, { warning: Warning; corpora: string[] }>();

  for (const { target, outcome } of perCorpus) {
    for (const warning of outcome.warnings) {
      // One corpus finding nothing is not an overall no-evidence result.
      if (warning.code === WarningCode.NO_SUFFICIENT_EVIDENCE) continue;
      const key = `${warning.code}\u0000${warning.message}`;
      const existing = grouped.get(key);
      if (existing === undefined) grouped.set(key, { warning, corpora: [target.name] });
      else existing.corpora.push(target.name);
    }
  }

  return [...grouped.values()].map(({ warning, corpora }) =>
    corpora.length === 1
      ? {
          ...warning,
          message: `${corpora[0]}: ${warning.message}`,
          details: { ...warning.details, corpus: corpora[0] },
        }
      : {
          ...warning,
          message: `${corpora.join(", ")}: ${warning.message}`,
          details: { ...warning.details, corpora },
        },
  );
}

/** Fall back to the largest per-corpus page size, so nothing is silently cut. */
function defaultTopK(perCorpus: ReadonlyArray<{ outcome: SearchOutcome }>): number {
  return Math.max(10, ...perCorpus.map(({ outcome }) => outcome.hits.length));
}

/**
 * Reciprocal Rank Fusion across corpora.
 *
 * Every hit keeps its per-signal scores from its own corpus, because those
 * describe how it was found there and remain true. Only `final` is replaced, by
 * the cross-corpus fused score, since the within-corpus value is not comparable
 * across corpora.
 */
function mergeByRank(
  perCorpus: ReadonlyArray<{ target: CorpusTarget; outcome: SearchOutcome }>,
  topK: number,
): HitView[] {
  interface Candidate {
    readonly hit: HitView;
    readonly raw: number;
  }

  const candidates: Candidate[] = [];
  for (const { outcome } of perCorpus) {
    outcome.hits.forEach((hit, index) => {
      candidates.push({ hit, raw: 1 / (CROSS_CORPUS_RRF_K + index + 1) });
    });
  }
  if (candidates.length === 0) return [];

  // Scale so the best result is 1.0, matching what single-corpus search reports.
  const best = Math.max(...candidates.map((candidate) => candidate.raw));

  return candidates
    .map(({ hit, raw }) => ({
      ...hit,
      scores: createScores({ ...hit.scores, final: best > 0 ? raw / best : 0 }),
    }))
    .sort((left, right) =>
      right.scores.final === left.scores.final
        ? // Ties are broken on corpus then chunk id, so repeating a query across
          // the same corpora returns the same order.
          compareStrings(left.corpus, right.corpus) || compareStrings(left.chunkId, right.chunkId)
        : right.scores.final - left.scores.final,
    )
    .slice(0, topK);
}

/**
 * The least reassuring freshness across the corpora.
 *
 * A stale corpus in the mix makes the whole answer possibly stale, so the
 * aggregate must not report `current` on the strength of the others.
 */
function worstFreshness(values: readonly Freshness[]): Freshness {
  if (values.length === 0) {
    return { status: "unknown", builtAt: null, sourceRevisions: {}, reason: "no corpus was searched" };
  }
  const stale = values.find((freshness) => freshness.status === "stale");
  if (stale !== undefined) return stale;
  const unknown = values.find((freshness) => freshness.status === "unknown");
  if (unknown !== undefined) return unknown;
  return values[0] as Freshness;
}

/** Interleave each corpus's suggestions, so no single corpus fills the list. */
function mergeSuggestions(lists: ReadonlyArray<readonly string[]>, limit = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((list) => list.length));

  for (let index = 0; index < longest && out.length < limit; index += 1) {
    for (const list of lists) {
      const suggestion = list[index];
      if (suggestion === undefined || seen.has(suggestion)) continue;
      seen.add(suggestion);
      out.push(suggestion);
      if (out.length >= limit) break;
    }
  }
  return out;
}
