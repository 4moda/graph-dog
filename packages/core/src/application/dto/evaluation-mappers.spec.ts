import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONTRACT_VERSION, SCHEMA_VERSION } from "./contracts.ts";
import { GATED_METRICS } from "../../domain/service/evaluation-gate.ts";
import type { EvaluationOutcome } from "../usecase/evaluate-corpus.ts";
import { baselineScoresFrom, toEvaluationReportDto } from "./evaluation-mappers.ts";

function outcome(overrides: Partial<EvaluationOutcome> = {}): EvaluationOutcome {
  return {
    dataset: "auth",
    corpus: "docs",
    embeddingId: "stub:v1:d3",
    k: 10,
    strategy: { fusion: "rrf", top_k: 10 },
    summary: {
      queries: 2,
      measured: 2,
      recallAtK: 1 / 3,
      precisionAtK: 0.1,
      mrr: 0.75,
      ndcgAtK: 0.5,
      evidenceAccuracy: 1,
      evidenceChecked: 3,
      zeroResultQueries: 0,
      missedQueries: 1,
    },
    latency: { meanMs: 12.34567, p50Ms: 11, p95Ms: 20, maxMs: 21 },
    failedQueries: 0,
    queries: [
      {
        id: "jwks",
        query: "JWKS",
        note: "rotation",
        metrics: {
          recallAtK: 1,
          precisionAtK: 0.1,
          reciprocalRank: 1,
          ndcgAtK: 1,
          evidence: { checked: 1, correct: 1, accuracy: 1 },
          retrieved: 2,
          relevant: 1,
        },
        elapsedMs: 11,
        retrievedRefs: ["docs/keys.md", "docs/token.md"],
        missingRefs: [],
        error: null,
      },
    ],
    comparison: null,
    gateFailures: [],
    warnings: [],
    passed: true,
    ...overrides,
  };
}

describe("application/dto/evaluation-mappers", () => {
  describe("toEvaluationReportDto", () => {
    it("stamps the envelope so a consumer can gate before parsing", () => {
      const dto = toEvaluationReportDto(outcome());
      assert.equal(dto.kind, "evaluation_report");
      assert.equal(dto.schema_version, SCHEMA_VERSION);
      assert.equal(dto.contract_version, CONTRACT_VERSION);
    });

    it("renames metrics to snake_case without changing their meaning", () => {
      const dto = toEvaluationReportDto(outcome());
      assert.equal(dto.summary.recall_at_k, 0.333333);
      assert.equal(dto.summary.mrr, 0.75);
      assert.equal(dto.summary.ndcg_at_k, 0.5);
      assert.equal(dto.summary.evidence_checked, 3);
    });

    it("rounds metrics so two runs of the same corpus diff cleanly", () => {
      const dto = toEvaluationReportDto(outcome());
      assert.equal(dto.summary.recall_at_k, 0.333333, "six digits, not seventeen");
    });

    it("rounds latency to a tenth of a millisecond", () => {
      const dto = toEvaluationReportDto(outcome());
      assert.equal(dto.summary.latency.mean_ms, 12.3);
    });

    it("keeps null metrics null rather than flattening them to zero", () => {
      const dto = toEvaluationReportDto(
        outcome({
          summary: { ...outcome().summary, recallAtK: null, evidenceAccuracy: null },
        }),
      );
      assert.equal(dto.summary.recall_at_k, null);
      assert.equal(dto.summary.evidence_accuracy, null);
    });

    it("flattens a query's evidence accuracy into three flat fields", () => {
      const dto = toEvaluationReportDto(outcome());
      assert.equal(dto.queries[0]?.metrics.evidence_checked, 1);
      assert.equal(dto.queries[0]?.metrics.evidence_correct, 1);
      assert.equal(dto.queries[0]?.metrics.evidence_accuracy, 1);
    });

    it("carries the retrieved and missing refs verbatim", () => {
      const dto = toEvaluationReportDto(outcome());
      assert.deepEqual(dto.queries[0]?.retrieved_refs, ["docs/keys.md", "docs/token.md"]);
      assert.deepEqual(dto.queries[0]?.missing_refs, []);
    });

    it("reports status ok when no gate was breached", () => {
      assert.equal(toEvaluationReportDto(outcome()).status, "ok");
    });

    it("reports status failed and lists why", () => {
      const dto = toEvaluationReportDto(
        outcome({
          passed: false,
          gateFailures: [
            {
              kind: "threshold",
              metric: "recall",
              observed: 0.2,
              required: 0.8,
              message: "recall 0.200 is below the required 0.800",
            },
          ],
        }),
      );
      assert.equal(dto.status, "failed");
      assert.equal(dto.gate_failures[0]?.metric, "recall");
      assert.equal(dto.gate_failures[0]?.observed, 0.2);
    });

    it("omits the comparison when no baseline was given", () => {
      assert.equal(toEvaluationReportDto(outcome()).comparison, null);
    });

    it("serializes every delta when a baseline was given", () => {
      const dto = toEvaluationReportDto(
        outcome({
          comparison: [
            { metric: "recall", baseline: 0.5, current: 0.75, delta: 0.25 },
            { metric: "ndcg", baseline: null, current: 0.5, delta: null },
          ],
        }),
      );
      assert.equal(dto.comparison?.length, 2);
      assert.equal(dto.comparison?.[0]?.delta, 0.25);
      assert.equal(dto.comparison?.[1]?.baseline, null);
    });

    it("survives a JSON round trip, which is what --baseline depends on", () => {
      const dto = toEvaluationReportDto(outcome());
      assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto);
    });
  });

  describe("baselineScoresFrom", () => {
    it("reads the gated scores back out of a report it wrote", () => {
      const dto = JSON.parse(JSON.stringify(toEvaluationReportDto(outcome())));
      assert.deepEqual(baselineScoresFrom(dto), {
        recall: 0.333333,
        precision: 0.1,
        mrr: 0.75,
        ndcg: 0.5,
        evidence: 1,
      });
    });

    it("accepts a bare summary as well as a whole report", () => {
      const summary = toEvaluationReportDto(outcome()).summary;
      assert.equal(baselineScoresFrom(summary).mrr, 0.75);
    });

    it("returns a value for every gated metric", () => {
      const scores = baselineScoresFrom({}) as unknown as Record<string, number | null>;
      assert.deepEqual(Object.keys(scores).sort(), [...GATED_METRICS].sort());
    });

    it("reads a missing metric as unmeasured rather than as zero", () => {
      // Treating it as 0 would report a catastrophic regression the moment an
      // older baseline met a newer metric.
      assert.equal(baselineScoresFrom({ summary: {} }).recall, null);
    });

    it("ignores a non-numeric metric instead of throwing", () => {
      assert.equal(baselineScoresFrom({ summary: { mrr: "0.9" } }).mrr, null);
    });

    it("rejects NaN and Infinity, which JSON can carry as nulls or strings", () => {
      assert.equal(baselineScoresFrom({ summary: { mrr: Number.POSITIVE_INFINITY } }).mrr, null);
    });

    it("tolerates a non-object baseline rather than crashing the run", () => {
      assert.equal(baselineScoresFrom(null).recall, null);
      assert.equal(baselineScoresFrom("not a report").recall, null);
    });
  });
});
