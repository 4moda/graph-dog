/**
 * Evaluation outcomes to wire DTOs.
 *
 * Separate from `mappers.ts` because the evaluation contract is a different
 * audience: a stored report is read by CI and by the next run's `--baseline`,
 * not by an agent mid-task. The round trip matters here in a way it does not
 * elsewhere, so the reader lives beside the writer.
 */

import type { AggregateMetrics } from "../../domain/service/metrics.ts";
import { GATED_METRICS, isGatedMetric, type GateScores } from "../../domain/service/evaluation-gate.ts";
import type {
  EvaluationDeltaDto,
  EvaluationGateDto,
  EvaluationLatencyDto,
  EvaluationMetricsDto,
  EvaluationQueryDto,
  EvaluationReportDto,
  EvaluationSummaryDto,
} from "./contracts.ts";
import { envelope, round } from "./contracts.ts";
import { toWarningDtos } from "./mappers.ts";
import type { EvaluationOutcome } from "../usecase/evaluate-corpus.ts";

export function toEvaluationReportDto(outcome: EvaluationOutcome): EvaluationReportDto {
  return {
    ...envelope("evaluation_report"),
    dataset: outcome.dataset,
    corpus: outcome.corpus,
    embedding_id: outcome.embeddingId,
    k: outcome.k,
    strategy: outcome.strategy,
    summary: toSummaryDto(outcome.summary, outcome.latency, outcome.failedQueries),
    queries: outcome.queries.map(toQueryDto),
    comparison:
      outcome.comparison === null
        ? null
        : outcome.comparison.map(
            (delta): EvaluationDeltaDto => ({
              metric: delta.metric,
              baseline: round(delta.baseline),
              current: round(delta.current),
              delta: round(delta.delta),
            }),
          ),
    status: outcome.passed ? "ok" : "failed",
    gate_failures: outcome.gateFailures.map(
      (failure): EvaluationGateDto => ({
        kind: failure.kind,
        metric: failure.metric,
        observed: round(failure.observed),
        required: round(failure.required),
        message: failure.message,
      }),
    ),
    warnings: toWarningDtos(outcome.warnings),
  };
}

function toSummaryDto(
  summary: AggregateMetrics,
  latency: {
    meanMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  },
  failedQueries: number,
): EvaluationSummaryDto {
  const latencyDto: EvaluationLatencyDto = {
    // Latency is reported to the millisecond: further digits would be noise
    // from the clock rather than information about the search.
    mean_ms: round(latency.meanMs, 1),
    p50_ms: round(latency.p50Ms, 1),
    p95_ms: round(latency.p95Ms, 1),
    max_ms: round(latency.maxMs, 1),
  };
  return {
    queries: summary.queries,
    measured: summary.measured,
    recall_at_k: round(summary.recallAtK),
    precision_at_k: round(summary.precisionAtK),
    mrr: round(summary.mrr),
    ndcg_at_k: round(summary.ndcgAtK),
    evidence_accuracy: round(summary.evidenceAccuracy),
    evidence_checked: summary.evidenceChecked,
    zero_result_queries: summary.zeroResultQueries,
    missed_queries: summary.missedQueries,
    no_answer_queries: summary.noAnswerQueries,
    abstention: summary.abstention,
    false_abstention: summary.falseAbstention,
    failed_queries: failedQueries,
    latency: latencyDto,
  };
}

function toQueryDto(query: EvaluationOutcome["queries"][number]): EvaluationQueryDto {
  const metrics: EvaluationMetricsDto = {
    recall_at_k: round(query.metrics.recallAtK),
    precision_at_k: round(query.metrics.precisionAtK),
    reciprocal_rank: round(query.metrics.reciprocalRank),
    ndcg_at_k: round(query.metrics.ndcgAtK),
    evidence_checked: query.metrics.evidence.checked,
    evidence_correct: query.metrics.evidence.correct,
    evidence_accuracy: round(query.metrics.evidence.accuracy),
    retrieved: query.metrics.retrieved,
    relevant: query.metrics.relevant,
  };
  return {
    id: query.id,
    query: query.query,
    note: query.note,
    metrics,
    elapsed_ms: query.elapsedMs,
    retrieved_refs: query.retrievedRefs,
    missing_refs: query.missingRefs,
    error: query.error,
  };
}

/**
 * Read the gated scores back out of a stored report, for `--baseline`.
 *
 * Deliberately tolerant about everything except the numbers: a baseline written
 * by an older build should still be comparable, and refusing it would push
 * people to delete the baseline rather than investigate the regression. A
 * missing or non-numeric metric reads as "not measured", which `checkGates`
 * already treats as nothing to have fallen from.
 */
export function baselineScoresFrom(report: unknown): GateScores {
  const summary = summaryOf(report);
  const keys: Record<string, string> = {
    recall: "recall_at_k",
    precision: "precision_at_k",
    mrr: "mrr",
    ndcg: "ndcg_at_k",
    evidence: "evidence_accuracy",
    abstention: "abstention",
    false_abstention: "false_abstention",
  };

  const scores: Record<string, number | null> = {};
  for (const metric of GATED_METRICS) {
    if (!isGatedMetric(metric)) continue;
    const value = summary[keys[metric] as string];
    const read = typeof value === "number" && Number.isFinite(value) ? value : null;
    // Stored as a rate, gated inverted, so that higher is better everywhere.
    scores[metric] = metric === "false_abstention" && read !== null ? 1 - read : read;
  }
  return scores as unknown as GateScores;
}

function summaryOf(report: unknown): Record<string, unknown> {
  if (typeof report !== "object" || report === null) return {};
  // Accepts either a whole report or just its summary, so a caller can store
  // the small object if that is all they kept.
  const record = report as Record<string, unknown>;
  const summary = record["summary"];
  if (typeof summary === "object" && summary !== null) return summary as Record<string, unknown>;
  return record;
}
