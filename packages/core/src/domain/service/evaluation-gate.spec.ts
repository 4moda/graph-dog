import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AggregateMetrics } from "./metrics.ts";
import {
  DEFAULT_TOLERANCE,
  GATED_METRICS,
  checkGates,
  compareScores,
  gateScores,
  isGatedMetric,
  parseGateSpec,
  type GateScores,
  type GatedMetric,
} from "./evaluation-gate.ts";

function scores(overrides: Partial<GateScores> = {}): GateScores {
  return { recall: 0.8, precision: 0.5, mrr: 0.75, ndcg: 0.7, evidence: 0.9, ...overrides };
}

function thresholds(entries: Partial<Record<GatedMetric, number>>): Map<GatedMetric, number> {
  return new Map(Object.entries(entries) as Array<[GatedMetric, number]>);
}

describe("domain/service/evaluation-gate", () => {
  describe("gateScores", () => {
    it("pulls the five gated metrics out of a full aggregate", () => {
      const aggregate: AggregateMetrics = {
        queries: 3,
        measured: 3,
        recallAtK: 0.6,
        precisionAtK: 0.2,
        mrr: 0.5,
        ndcgAtK: 0.55,
        evidenceAccuracy: 1,
        evidenceChecked: 4,
        zeroResultQueries: 0,
        missedQueries: 1,
      };
      assert.deepEqual(gateScores(aggregate), {
        recall: 0.6,
        precision: 0.2,
        mrr: 0.5,
        ndcg: 0.55,
        evidence: 1,
      });
    });

    it("carries nulls through rather than turning them into zeros", () => {
      const aggregate: AggregateMetrics = {
        queries: 1,
        measured: 0,
        recallAtK: null,
        precisionAtK: null,
        mrr: null,
        ndcgAtK: null,
        evidenceAccuracy: null,
        evidenceChecked: 0,
        zeroResultQueries: 0,
        missedQueries: 0,
      };
      assert.equal(gateScores(aggregate).recall, null);
    });
  });

  describe("thresholds", () => {
    it("passes when every gated metric clears its floor", () => {
      const failures = checkGates({
        current: scores(),
        thresholds: thresholds({ recall: 0.7, mrr: 0.7 }),
      });
      assert.deepEqual(failures, []);
    });

    it("fails the metric that fell short, and names the numbers", () => {
      const failures = checkGates({
        current: scores({ recall: 0.42 }),
        thresholds: thresholds({ recall: 0.7 }),
      });
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.kind, "threshold");
      assert.equal(failures[0]?.metric, "recall");
      assert.equal(failures[0]?.observed, 0.42);
      assert.equal(failures[0]?.required, 0.7);
      assert.match(failures[0]?.message ?? "", /0\.420.*0\.700/);
    });

    it("treats exactly meeting the floor as passing", () => {
      const failures = checkGates({
        current: scores({ recall: 0.7 }),
        thresholds: thresholds({ recall: 0.7 }),
      });
      assert.deepEqual(failures, []);
    });

    it("ignores metrics that were not gated", () => {
      const failures = checkGates({
        current: scores({ precision: 0.01 }),
        thresholds: thresholds({ recall: 0.5 }),
      });
      assert.deepEqual(failures, []);
    });

    it("fails a gated metric the dataset cannot measure, rather than passing it", () => {
      // A dataset that stopped judging anything must not make the gate go green
      // exactly when it stopped doing its job.
      const failures = checkGates({
        current: scores({ recall: null }),
        thresholds: thresholds({ recall: 0.5 }),
      });
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.observed, null);
      assert.match(failures[0]?.message ?? "", /cannot measure/);
    });

    it("reports several breached floors at once", () => {
      const failures = checkGates({
        current: scores({ recall: 0.1, mrr: 0.1 }),
        thresholds: thresholds({ recall: 0.5, mrr: 0.5, ndcg: 0.1 }),
      });
      assert.deepEqual(
        failures.map((failure) => failure.metric),
        ["recall", "mrr"],
      );
    });

    it("reports failures in GATED_METRICS order regardless of insertion order", () => {
      const out = checkGates({
        current: scores({ recall: 0, precision: 0, evidence: 0 }),
        thresholds: new Map<GatedMetric, number>([
          ["evidence", 0.5],
          ["recall", 0.5],
          ["precision", 0.5],
        ]),
      });
      assert.deepEqual(
        out.map((failure) => failure.metric),
        ["recall", "precision", "evidence"],
      );
    });
  });

  describe("regression against a baseline", () => {
    it("passes when nothing moved", () => {
      assert.deepEqual(checkGates({ current: scores(), baseline: scores() }), []);
    });

    it("passes a small drop inside the tolerance", () => {
      const failures = checkGates({
        current: scores({ recall: 0.8 - DEFAULT_TOLERANCE / 2 }),
        baseline: scores(),
      });
      assert.deepEqual(failures, []);
    });

    it("fails a drop beyond the tolerance", () => {
      const failures = checkGates({ current: scores({ recall: 0.5 }), baseline: scores() });
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.kind, "regression");
      assert.equal(failures[0]?.required, 0.8, "the baseline is what it had to stay near");
      assert.match(failures[0]?.message ?? "", /fell from 0\.800 to 0\.500/);
    });

    it("never fails an improvement, however large", () => {
      assert.deepEqual(checkGates({ current: scores({ recall: 1 }), baseline: scores() }), []);
    });

    it("honours a custom tolerance", () => {
      const options = { current: scores({ recall: 0.75 }), baseline: scores() };
      assert.deepEqual(checkGates({ ...options, tolerance: 0.1 }), []);
      assert.equal(checkGates({ ...options, tolerance: 0.001 }).length, 1);
    });

    it("fails a metric that became unmeasurable after the baseline measured it", () => {
      const failures = checkGates({ current: scores({ evidence: null }), baseline: scores() });
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.metric, "evidence");
      assert.match(failures[0]?.message ?? "", /no longer measurable/);
    });

    it("ignores a metric the baseline itself could not measure", () => {
      const failures = checkGates({
        current: scores({ evidence: 0.1 }),
        baseline: scores({ evidence: null }),
      });
      assert.deepEqual(failures, []);
    });

    it("reports threshold failures before regressions", () => {
      const failures = checkGates({
        current: scores({ recall: 0.1, mrr: 0.1 }),
        baseline: scores(),
        thresholds: thresholds({ mrr: 0.5 }),
      });
      assert.equal(failures[0]?.kind, "threshold");
      assert.ok(failures.slice(1).every((failure) => failure.kind === "regression"));
    });
  });

  describe("compareScores", () => {
    it("returns one delta per gated metric, in a stable order", () => {
      const deltas = compareScores(scores(), scores());
      assert.deepEqual(
        deltas.map((delta) => delta.metric),
        [...GATED_METRICS],
      );
    });

    it("computes current minus baseline", () => {
      const deltas = compareScores(scores({ recall: 0.5 }), scores({ recall: 0.75 }));
      const recall = deltas.find((delta) => delta.metric === "recall");
      assert.equal(recall?.baseline, 0.5);
      assert.equal(recall?.current, 0.75);
      assert.ok(Math.abs((recall?.delta ?? 0) - 0.25) < 1e-9);
    });

    it("leaves the delta null when either side is unmeasurable", () => {
      const deltas = compareScores(scores({ ndcg: null }), scores());
      const ndcg = deltas.find((delta) => delta.metric === "ndcg");
      assert.equal(ndcg?.delta, null);
      assert.equal(ndcg?.current, 0.7, "the measurable side is still reported");
    });
  });

  describe("parseGateSpec", () => {
    it("parses metric=value", () => {
      assert.deepEqual(parseGateSpec("recall=0.8"), ["recall", 0.8]);
    });

    it("tolerates surrounding whitespace and capitalisation", () => {
      assert.deepEqual(parseGateSpec("  NDCG = 0.5 "), ["ndcg", 0.5]);
    });

    it("accepts the endpoints 0 and 1", () => {
      assert.deepEqual(parseGateSpec("mrr=0"), ["mrr", 0]);
      assert.deepEqual(parseGateSpec("mrr=1"), ["mrr", 1]);
    });

    it("rejects an unknown metric instead of gating nothing", () => {
      // A typo that silently gates nothing is a CI job that is green because it
      // checks nothing.
      assert.throws(() => parseGateSpec("recal=0.8"), /unknown metric/);
    });

    it("rejects a spec with no value", () => {
      assert.throws(() => parseGateSpec("recall"), /expected <metric>=<value>/);
      assert.throws(() => parseGateSpec("recall="), /must be a number/);
    });

    it("rejects values outside 0 to 1", () => {
      assert.throws(() => parseGateSpec("recall=80"), /0 to 1/);
      assert.throws(() => parseGateSpec("recall=-0.1"), /0 to 1/);
      assert.throws(() => parseGateSpec("recall=banana"), /0 to 1/);
    });
  });

  describe("isGatedMetric", () => {
    it("recognizes every name in GATED_METRICS", () => {
      assert.ok(GATED_METRICS.every((metric) => isGatedMetric(metric)));
    });

    it("rejects anything else", () => {
      assert.equal(isGatedMetric("f1"), false);
    });
  });
});
