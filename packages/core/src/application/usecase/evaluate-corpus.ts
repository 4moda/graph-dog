/**
 * Measuring retrieval quality against a judged dataset.
 *
 * Runs every query in the dataset through the *same* `searchCorpus` the CLI and
 * the MCP server call -- not a reimplementation of it -- and scores the results
 * with the pure metrics in the domain. That is the point of the harness: a
 * number it reports is a number a caller would actually get.
 *
 * What it is for: GraphDog ships with a lexical embedder by default and a
 * semantic one behind an opt-in. Without measurement that default is an
 * assertion. With it, changing fusion weights, the dense floor or the chunker
 * becomes a decision someone can check rather than argue about.
 *
 * A query that throws is recorded as a failure and scored as a miss rather than
 * aborting the run: a dataset of forty queries should not lose its report
 * because one of them hit a bad extractor.
 */

import {
  aggregate,
  mean,
  percentile,
  scoreQuery,
  type AggregateMetrics,
  type Judgment,
  type QueryMetrics,
  type RetrievedItem,
} from "../../domain/service/metrics.ts";
import {
  checkGates,
  gateScores,
  compareScores,
  type GateFailure,
  type GateScores,
  type GatedMetric,
  type MetricDelta,
} from "../../domain/service/evaluation-gate.ts";
import { compareStrings } from "../../domain/ordering.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { Warning } from "../dto/mappers.ts";
import type { EvalDataset, EvalQuery } from "../../infrastructure/config/eval-dataset.ts";
import { SILENT_LOGGER } from "../ports/system.ts";
import { searchCorpus, type SearchDependencies, type SearchOptions } from "./search-corpus.ts";

/** Rank cutoff for the @K metrics when the caller names none. */
export const DEFAULT_EVAL_K = 10;

export interface EvaluateOptions {
  readonly dataset: EvalDataset;
  /** Cutoff for every @K metric, and the number of hits requested. */
  readonly k?: number;
  /** Overrides handed to each search, so a run can measure one setting at a time. */
  readonly minScore?: number;
  readonly hops?: number;
  readonly rerank?: boolean;
  /** A previous run's scores; when given, the report compares against them. */
  readonly baseline?: GateScores | null;
  readonly thresholds?: ReadonlyMap<GatedMetric, number> | null;
  readonly tolerance?: number;
}

export interface EvaluatedQuery {
  readonly id: string;
  readonly query: string;
  readonly note: string | null;
  readonly metrics: QueryMetrics;
  readonly elapsedMs: number;
  readonly retrievedRefs: string[];
  readonly missingRefs: string[];
  readonly error: string | null;
}

export interface LatencySummary {
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

export interface EvaluationOutcome {
  readonly dataset: string;
  readonly corpus: string;
  readonly embeddingId: string;
  readonly k: number;
  readonly strategy: Record<string, unknown>;
  readonly summary: AggregateMetrics;
  readonly latency: LatencySummary;
  readonly failedQueries: number;
  readonly queries: EvaluatedQuery[];
  readonly comparison: MetricDelta[] | null;
  readonly gateFailures: GateFailure[];
  readonly warnings: Warning[];
  /** True when no gate was breached. The caller maps this to an exit code. */
  readonly passed: boolean;
}

export async function evaluateCorpus(
  options: EvaluateOptions,
  dependencies: SearchDependencies,
): Promise<EvaluationOutcome> {
  const logger = dependencies.logger ?? SILENT_LOGGER;
  const k = options.k ?? DEFAULT_EVAL_K;
  const warnings: Warning[] = [];

  warnUnknownRefs(options.dataset, dependencies, warnings);

  const queries: EvaluatedQuery[] = [];
  let strategy: Record<string, unknown> = {};

  for (const entry of options.dataset.queries) {
    const searchOptions: SearchOptions = {
      query: entry.query,
      topK: k,
      ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
      ...(options.hops === undefined ? {} : { hops: options.hops }),
      ...(options.rerank === undefined ? {} : { rerank: options.rerank }),
    };

    const startedAt = Date.now();
    try {
      const outcome = await searchCorpus(searchOptions, dependencies);
      // Recorded from the last successful query: every query in a run uses the
      // same settings, and reporting them makes a stored report self-describing.
      strategy = outcome.strategy;
      queries.push(
        evaluated(entry, toRetrieved(outcome.hits), k, Date.now() - startedAt, null, outcome.noEvidence),
      );
    } catch (error) {
      const message = String(error);
      logger.log("warn", "evaluation query failed", { id: entry.id, error: message });
      warnings.push({
        code: WarningCode.EVAL_QUERY_FAILED,
        message: `query "${entry.id}" failed: ${message}`,
        details: { id: entry.id },
      });
      // A query that threw returned nothing, which is not the same as declining
      // to answer: counting a crash as an abstention would flatter the metric.
      queries.push(evaluated(entry, [], k, Date.now() - startedAt, message, false));
    }
  }

  const summary = aggregate(queries.map((query) => query.metrics));
  const current = gateScores(summary);
  const baseline = options.baseline ?? null;

  const gateFailures = checkGates({
    current,
    baseline,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
  });

  return {
    dataset: options.dataset.name,
    corpus: dependencies.config.name,
    embeddingId: dependencies.embedding.id,
    k,
    strategy,
    summary,
    latency: summarizeLatency(queries.map((query) => query.elapsedMs)),
    failedQueries: queries.filter((query) => query.error !== null).length,
    queries,
    comparison: baseline === null ? null : compareScores(baseline, current),
    gateFailures,
    warnings,
    passed: gateFailures.length === 0,
  };
}

/** Score one query's results against its judgments. */
function evaluated(
  entry: EvalQuery,
  retrieved: RetrievedItem[],
  k: number,
  elapsedMs: number,
  error: string | null,
  abstained: boolean,
): EvaluatedQuery {
  const found = new Set(retrieved.slice(0, k).map((item) => item.ref));
  return {
    id: entry.id,
    query: entry.query,
    note: entry.note,
    metrics: scoreQuery(retrieved, entry.judgments, k, { expect: entry.expect, abstained }),
    elapsedMs,
    // Deduplicated in rank order: the report is about documents, and a repeated
    // ref is three chunks of one file, not three findings.
    retrievedRefs: [...new Set(retrieved.map((item) => item.ref))],
    missingRefs: missedRefs(entry.judgments, found),
    error,
  };
}

function missedRefs(judgments: readonly Judgment[], found: ReadonlySet<string>): string[] {
  const missing = new Set<string>();
  for (const judgment of judgments) {
    if (judgment.grade > 0 && !found.has(judgment.ref)) missing.add(judgment.ref);
  }
  return [...missing].sort(compareStrings);
}

/** Reduce hits to what the metrics need: a ref and the lines it cites. */
function toRetrieved(
  hits: readonly { ref: string; location: { startLine: number; endLine: number; page: number | null } }[],
): RetrievedItem[] {
  return hits.map((hit) => ({
    ref: hit.ref,
    startLine: hit.location.startLine,
    endLine: hit.location.endLine,
    page: hit.location.page,
  }));
}

function summarizeLatency(samples: readonly number[]): LatencySummary {
  return {
    meanMs: mean(samples),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: samples.length === 0 ? null : Math.max(...samples),
  };
}

/**
 * Warn about judged refs the corpus does not contain.
 *
 * A typo'd or since-renamed ref scores as a permanent miss, which reads as a
 * retrieval failure and sends someone tuning weights to chase a broken dataset.
 * Naming it costs one pass over the document list.
 */
function warnUnknownRefs(
  dataset: EvalDataset,
  dependencies: SearchDependencies,
  warnings: Warning[],
): void {
  const known = new Set(dependencies.store.documents.listRefs());
  if (known.size === 0) return;

  const unknown = new Set<string>();
  for (const query of dataset.queries) {
    for (const judgment of query.judgments) {
      if (judgment.grade > 0 && !known.has(judgment.ref)) unknown.add(judgment.ref);
    }
  }
  if (unknown.size === 0) return;

  const refs = [...unknown].sort(compareStrings);
  warnings.push({
    code: WarningCode.EVAL_UNKNOWN_REF,
    message:
      `${refs.length} judged ref(s) are not in this corpus and can never be found; ` +
      "the dataset may be stale or point at another corpus",
    details: { refs: refs.slice(0, 20), total: refs.length },
  });
}
