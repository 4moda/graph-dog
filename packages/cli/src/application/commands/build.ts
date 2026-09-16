/**
 * `graphdog build` and `graphdog update`.
 *
 * The same use case: `build` is `update --full`. They are separate command
 * names because "index everything" and "pick up what changed" are different
 * intentions, and an agent should not have to remember a flag to get the cheap
 * one.
 *
 * `--all` exists for the same reason `search --all` does, and for one more: an
 * update run from a hook has to refresh every corpus a search might reach. One
 * that quietly refreshed the first of three would be the silent staleness the
 * whole trigger exists to prevent.
 */

import {
  envelope,
  ConfigError,
  ExitCode,
  buildCorpus,
  discoverCorpusNames,
  openCorpus,
  type BuildReportDto,
  type BuildReportsDto,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import {
  optionBoolean,
  optionCorpora,
  optionList,
  optionSingleCorpus,
  type CommandSpec,
} from "../../infrastructure/argv.ts";
import { renderBuildReport, renderBuildReports } from "../../infrastructure/render/human-renderer.ts";

export const buildSpec: CommandSpec = {
  name: "build",
  summary: "Index every source into the corpus",
  usage: "graphdog build [--corpus <name>] [--all] [--source <id>] [--incremental]",
  options: {
    source: { type: "string", multiple: true, description: "Only build these source ids (repeatable)", placeholder: "<id>" },
    all: { type: "boolean", description: "Every corpus visible from here" },
    incremental: { type: "boolean", description: "Only re-index files whose content changed" },
  },
  examples: ["graphdog build", "graphdog build --source docs"],
};

export const updateSpec: CommandSpec = {
  name: "update",
  summary: "Re-index only what changed since the last build",
  usage: "graphdog update [--corpus <name>] [--all] [--source <id>] [--full]",
  options: {
    source: { type: "string", multiple: true, description: "Only update these source ids (repeatable)", placeholder: "<id>" },
    all: { type: "boolean", description: "Every corpus visible from here" },
    full: { type: "boolean", description: "Re-index everything, ignoring content hashes" },
  },
  examples: ["graphdog update", "graphdog update --all"],
};

export async function runBuild(context: CommandContext, full: boolean): Promise<CommandResult> {
  const names = await targetNames(context);
  if (names.length <= 1) return one(context, full, names[0]);

  const reports: BuildReportDto[] = [];
  for (const name of names) {
    const result = await one(context, full, name);
    reports.push(result.json as BuildReportDto);
  }

  const status = reports.some((report) => report.status === "partial") ? "partial" : "ok";
  const dto: BuildReportsDto = { ...envelope("build_reports"), status, reports };
  return {
    json: dto,
    human: renderBuildReports(dto),
    ...(status === "partial" ? { exitCode: ExitCode.PARTIAL } : {}),
  };
}

/**
 * Which corpora to build.
 *
 * An empty list means "let the workspace decide", which is how a project with
 * one corpus needs no flags at all.
 */
async function targetNames(context: CommandContext): Promise<string[]> {
  const explicit = optionCorpora(context.parsed);
  if (!optionBoolean(context.parsed, "all")) {
    // Still routed through `optionSingleCorpus` so that repeating `--corpus`
    // without `--all` is refused rather than silently building the first.
    const single = optionSingleCorpus(context.parsed, "build");
    return single === undefined ? [] : [single];
  }
  const discovered = await discoverCorpusNames(context.cwd);
  const names = [...new Set([...explicit, ...discovered])];
  if (names.length === 0) {
    throw new ConfigError("--all found no corpora", { remedy: "graphdog init" });
  }
  return names;
}

async function one(
  context: CommandContext,
  full: boolean,
  name: string | undefined,
): Promise<CommandResult> {
  const explicitFull = optionBoolean(context.parsed, "full");
  const incremental = optionBoolean(context.parsed, "incremental");
  const onlySources = optionList(context.parsed, "source");

  const corpus = await openCorpus({
    ...(name === undefined ? {} : { corpus: name }),
    cwd: context.cwd,
    logger: context.logger,
  });
  try {
    if (corpus.config.sources.length === 0) {
      throw new ConfigError(`corpus "${corpus.name}" has no sources`, {
        remedy: "graphdog add <path>",
      });
    }

    const outcome = await buildCorpus(
      {
        full: explicitFull || (full && !incremental),
        ...(onlySources.length === 0 ? {} : { onlySources }),
      },
      {
        store: corpus.store,
        config: corpus.config,
        sources: corpus.sources,
        extractors: corpus.extractors,
        embedding: corpus.embedding,
        clock: corpus.clock,
        hasher: corpus.hasher,
        readFile: corpus.readFile,
        logger: corpus.logger,
      },
    );

    const report: BuildReportDto = {
      ...envelope("build_report"),
      corpus: outcome.corpus,
      status: outcome.status,
      documents: outcome.documents,
      chunks: outcome.chunks,
      nodes: outcome.nodes,
      edges: outcome.edges,
      failures: outcome.failures,
      exclusions: outcome.exclusions,
      elapsed_seconds: Math.round(outcome.elapsedSeconds * 1000) / 1000,
      warnings: outcome.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        details: warning.details ?? {},
      })),
    };

    return {
      json: report,
      human: renderBuildReport(report),
      // A partial build is reported as partial in the exit code too, so a
      // script that only checks the status still notices.
      ...(outcome.status === "partial" ? { exitCode: ExitCode.PARTIAL } : {}),
    };
  } finally {
    corpus.close();
  }
}
