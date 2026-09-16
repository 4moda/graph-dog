/**
 * Turning an evaluation into a pass or a fail.
 *
 * Two independent questions, both pure arithmetic over aggregate metrics:
 *
 * - **Is it good enough?** A floor the run must clear, e.g. `recall=0.8`.
 * - **Is it worse than it was?** A comparison against a stored baseline report.
 *
 * Kept separate from the run itself so the policy can be unit-tested against
 * hand-written numbers, and so CI and a local `--fail-under` share one
 * definition of "regressed" rather than two that drift.
 */

import type { AggregateMetrics } from "./metrics.ts";

/** The metrics a gate may be set on, spelled as a caller would type them. */
export const GATED_METRICS = [
  "recall",
  "precision",
  "mrr",
  "ndcg",
  "evidence",
  // Refusing a question the corpus cannot answer is a property worth defending
  // against regression like any other, and it is the one an agent leans on
  // hardest. `false_abstention` guards the other direction, because a search
  // that refuses everything would score a perfect `abstention`.
  "abstention",
  "false_abstention",
] as const;

export type GatedMetric = (typeof GATED_METRICS)[number];

/**
 * Default slack when comparing against a baseline.
 *
 * Retrieval numbers move slightly for reasons that are not regressions -- a
 * reindex reordering equally-scored ties, a corpus gaining a document. Zero
 * tolerance would make the gate cry wolf until someone disabled it, which is a
 * worse outcome than a gate that misses a one-point drop.
 */
export const DEFAULT_TOLERANCE = 0.01;

/** The gated metrics, pulled out of a full aggregate. */
export interface GateScores {
  readonly recall: number | null;
  readonly precision: number | null;
  readonly mrr: number | null;
  readonly ndcg: number | null;
  readonly evidence: number | null;
  readonly abstention: number | null;
  /** Stored inverted -- 1 minus the rate -- so higher is better here as everywhere. */
  readonly false_abstention: number | null;
}

export function gateScores(metrics: AggregateMetrics): GateScores {
  return {
    recall: metrics.recallAtK,
    precision: metrics.precisionAtK,
    mrr: metrics.mrr,
    ndcg: metrics.ndcgAtK,
    evidence: metrics.evidenceAccuracy,
    abstention: metrics.abstention,
    // Inverted so that, like every other gated metric, higher is better and a
    // fall below the baseline is the failure.
    false_abstention: metrics.falseAbstention === null ? null : 1 - metrics.falseAbstention,
  };
}

export interface GateFailure {
  readonly kind: "threshold" | "regression";
  readonly metric: GatedMetric;
  readonly observed: number | null;
  /** The floor, or the baseline value the run had to stay near. */
  readonly required: number | null;
  readonly message: string;
}

export interface MetricDelta {
  readonly metric: GatedMetric;
  readonly baseline: number | null;
  readonly current: number | null;
  /** `current - baseline`, or null when either side is unmeasurable. */
  readonly delta: number | null;
}

/** Every gated metric, then versus now. Ordered by `GATED_METRICS`. */
export function compareScores(baseline: GateScores, current: GateScores): MetricDelta[] {
  return GATED_METRICS.map((metric) => {
    const before = baseline[metric];
    const after = current[metric];
    return {
      metric,
      baseline: before,
      current: after,
      delta: before === null || after === null ? null : after - before,
    };
  });
}

export interface GateOptions {
  readonly current: GateScores;
  /** A previous run's scores, when one was supplied. */
  readonly baseline?: GateScores | null;
  /** Floors, keyed by metric. A metric with no entry is not gated. */
  readonly thresholds?: ReadonlyMap<GatedMetric, number> | null;
  readonly tolerance?: number;
}

/**
 * Every reason this run should be rejected, thresholds first.
 *
 * An unmeasurable metric that was explicitly gated *fails*. Passing it would
 * mean a dataset that quietly stopped judging anything would also quietly stop
 * enforcing the floor -- the gate would go green exactly when it stopped
 * working.
 */
export function checkGates(options: GateOptions): GateFailure[] {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const failures: GateFailure[] = [];

  const thresholds = options.thresholds ?? null;
  if (thresholds !== null) {
    for (const metric of GATED_METRICS) {
      const floor = thresholds.get(metric);
      if (floor === undefined) continue;
      const observed = options.current[metric];
      if (observed === null) {
        failures.push({
          kind: "threshold",
          metric,
          observed: null,
          required: floor,
          message: `${metric} was gated at ${floor} but the dataset cannot measure it`,
        });
      } else if (observed < floor) {
        failures.push({
          kind: "threshold",
          metric,
          observed,
          required: floor,
          message: `${metric} ${format(observed)} is below the required ${format(floor)}`,
        });
      }
    }
  }

  const baseline = options.baseline ?? null;
  if (baseline !== null) {
    for (const { metric, baseline: before, current: after, delta } of compareScores(
      baseline,
      options.current,
    )) {
      // A metric the baseline could not measure is not a regression: there is
      // nothing to have fallen from.
      if (before === null) continue;
      if (after === null) {
        failures.push({
          kind: "regression",
          metric,
          observed: null,
          required: before,
          message: `${metric} was ${format(before)} in the baseline and is no longer measurable`,
        });
        continue;
      }
      if (delta !== null && delta < -tolerance) {
        failures.push({
          kind: "regression",
          metric,
          observed: after,
          required: before,
          message: `${metric} fell from ${format(before)} to ${format(after)} (${format(delta)})`,
        });
      }
    }
  }

  return failures;
}

/**
 * Parse a `metric=value` gate spec.
 *
 * Rejects unknown metric names rather than ignoring them: `--fail-under
 * recal=0.8` that silently gates nothing is a CI job that is green because it
 * checks nothing.
 */
export function parseGateSpec(spec: string): [GatedMetric, number] {
  const separator = spec.indexOf("=");
  if (separator < 0) {
    throw new Error(`expected <metric>=<value>, got ${JSON.stringify(spec)}`);
  }
  const name = spec.slice(0, separator).trim().toLowerCase();
  const raw = spec.slice(separator + 1).trim();

  if (!isGatedMetric(name)) {
    throw new Error(`unknown metric ${JSON.stringify(name)}; expected one of ${GATED_METRICS.join(", ")}`);
  }
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} threshold must be a number from 0 to 1, got ${JSON.stringify(raw)}`);
  }
  return [name, value];
}

export function isGatedMetric(name: string): name is GatedMetric {
  return (GATED_METRICS as readonly string[]).includes(name);
}

function format(value: number): string {
  return value.toFixed(3);
}
