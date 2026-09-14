/**
 * `graphdog eval` -- measure retrieval quality against a judged dataset.
 *
 * The reason this command exists: GraphDog ships with a lexical embedder by
 * default and a semantic one behind an opt-in, and it fuses three signals with
 * weights someone chose. Without a way to measure, every one of those choices
 * is an assertion. With it, "the default is good enough" becomes a number
 * anyone can reproduce, and changing a weight becomes a diff with a result.
 *
 * It is also a CI gate. `--fail-under recall=0.8` and `--baseline` exit
 * non-zero, so a change that quietly makes search worse fails a build instead
 * of being noticed a month later.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ConfigError,
  ExitCode,
  UsageError,
  assertCompatible,
  baselineScoresFrom,
  evaluateCorpus,
  loadEvalDataset,
  openCorpus,
  parseGateSpec,
  toEvaluationReportDto,
  type CorpusContext,
  type GateScores,
  type GatedMetric,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import {
  optionBoolean,
  optionList,
  optionNumber,
  optionSingleCorpus,
  optionString,
  type CommandSpec,
} from "../../infrastructure/argv.ts";
import { renderEvaluation } from "../../infrastructure/render/human-renderer.ts";
import { renderJson } from "../../infrastructure/render/json-renderer.ts";

export const evalSpec: CommandSpec = {
  name: "eval",
  summary: "Measure retrieval quality against a judged dataset",
  usage: "graphdog eval <dataset.json> [--corpus <name>] [--fail-under <metric>=<n>]... [--json]",
  options: {
    "top-k": { type: "string", short: "k", description: "Rank cutoff for every @K metric", placeholder: "<n>" },
    "min-score": { type: "string", description: "Drop results below this fused score (0-1)", placeholder: "<n>" },
    hops: { type: "string", description: "Graph expansion depth; 0 disables the graph", placeholder: "<n>" },
    rerank: { type: "boolean", description: "Measure with the cross-encoder enabled" },
    "no-rerank": { type: "boolean", description: "Measure without reranking" },
    baseline: {
      type: "string",
      description: "A previous report to compare against; a drop beyond --tolerance fails",
      placeholder: "<report.json>",
    },
    tolerance: {
      type: "string",
      description: "How far a metric may fall below the baseline before it counts (default 0.01)",
      placeholder: "<n>",
    },
    "fail-under": {
      type: "string",
      multiple: true,
      description: "Require <metric>=<n>, e.g. recall=0.8 (repeatable)",
      placeholder: "<metric>=<n>",
    },
    out: { type: "string", description: "Write the report here, as the next run's baseline", placeholder: "<path>" },
  },
  examples: [
    "graphdog eval eval/auth.json",
    "graphdog eval eval/auth.json --fail-under recall=0.8 --fail-under mrr=0.6",
    "graphdog eval eval/auth.json --baseline eval/baseline.json --out eval/latest.json",
  ],
};

export async function runEval(context: CommandContext): Promise<CommandResult> {
  const datasetPath = context.parsed.positionals[0];
  if (datasetPath === undefined) {
    throw new UsageError("eval: a dataset file is required", { usage: evalSpec.usage });
  }

  const dataset = await loadEvalDataset(resolve(context.cwd, datasetPath));

  // The dataset may name its own corpus, so a dataset checked in beside the
  // documents it judges runs with no flags at all. An explicit --corpus still
  // wins, which is how one dataset is used to compare two corpora.
  const named = optionSingleCorpus(context.parsed, "eval") ?? dataset.corpus ?? undefined;

  const thresholds = parseThresholds(optionList(context.parsed, "fail-under"));
  const baseline = await readBaseline(context, datasetPath);

  const corpus = await openForEval(context, named);
  try {
    const outcome = await evaluateCorpus(
      {
        dataset,
        ...numeric("k", optionNumber(context.parsed, "top-k", "eval")),
        ...numeric("minScore", optionNumber(context.parsed, "min-score", "eval")),
        ...numeric("hops", optionNumber(context.parsed, "hops", "eval")),
        ...numeric("tolerance", optionNumber(context.parsed, "tolerance", "eval")),
        ...rerankChoice(context),
        ...(baseline === null ? {} : { baseline }),
        ...(thresholds === null ? {} : { thresholds }),
      },
      {
        store: corpus.store,
        config: corpus.config,
        embedding: corpus.embedding,
        freshness: corpus.freshness(),
        reranker: await corpus.reranker(),
        logger: corpus.logger,
      },
    );

    const report = toEvaluationReportDto(outcome);

    const out = optionString(context.parsed, "out");
    if (out !== undefined) {
      await writeFile(resolve(context.cwd, out), renderJson(report), "utf8");
      context.logger.log("info", "wrote evaluation report", { path: out });
    }

    return {
      json: report,
      human: renderEvaluation(report),
      // A breached gate gets its own exit code: the run itself succeeded, and a
      // CI job needs to tell "search got worse" apart from "the command was
      // wrong" without parsing the report.
      ...(outcome.passed ? {} : { exitCode: ExitCode.GATE_FAILED }),
    };
  } finally {
    corpus.close();
  }
}

/** Open the corpus and refuse to measure it if its stored identities do not match. */
async function openForEval(
  context: CommandContext,
  name: string | undefined,
): Promise<CorpusContext> {
  const corpus = await openCorpus({
    ...(name === undefined ? {} : { corpus: name }),
    cwd: context.cwd,
    logger: context.logger,
  });
  try {
    // Measuring a corpus this build cannot read would produce numbers that
    // describe nothing.
    assertCompatible(corpus.store, corpus.config, corpus.embedding);
    return corpus;
  } catch (error) {
    corpus.close();
    throw error;
  }
}

function parseThresholds(specs: readonly string[]): Map<GatedMetric, number> | null {
  if (specs.length === 0) return null;
  const thresholds = new Map<GatedMetric, number>();
  for (const spec of specs) {
    try {
      const [metric, value] = parseGateSpec(spec);
      thresholds.set(metric, value);
    } catch (error) {
      throw new UsageError(`eval: --fail-under ${String(error instanceof Error ? error.message : error)}`);
    }
  }
  return thresholds;
}

/**
 * Load the baseline report, if one was named.
 *
 * A missing baseline file is an error rather than "no baseline": in CI the
 * difference between "nothing regressed" and "the comparison never ran" is the
 * whole value of the gate.
 */
async function readBaseline(
  context: CommandContext,
  datasetPath: string,
): Promise<GateScores | null> {
  const path = optionString(context.parsed, "baseline");
  if (path === undefined) return null;

  const resolved = resolve(context.cwd, path);
  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (error) {
    throw new ConfigError(`eval: baseline not found: ${path}`, {
      cause: String(error),
      hint: `write one first: graphdog eval ${datasetPath} --out ${path}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`eval: baseline is not valid JSON: ${path}`, { cause: String(error) });
  }
  return baselineScoresFrom(parsed);
}

function numeric<K extends string>(key: K, value: number | undefined): Record<K, number> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

function rerankChoice(context: CommandContext): { rerank?: boolean } {
  if (optionBoolean(context.parsed, "no-rerank")) return { rerank: false };
  if (optionBoolean(context.parsed, "rerank")) return { rerank: true };
  return {};
}
