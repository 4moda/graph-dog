/**
 * `graphdog build` and `graphdog update`.
 *
 * The same use case: `build` is `update --full`. They are separate command
 * names because "index everything" and "pick up what changed" are different
 * intentions, and an agent should not have to remember a flag to get the cheap
 * one.
 */

import {
  envelope,
  ConfigError,
  ExitCode,
  buildCorpus,
  openCorpus,
  type BuildReportDto,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import { optionBoolean, optionList, optionSingleCorpus, type CommandSpec } from "../../infrastructure/argv.ts";
import { renderBuildReport } from "../../infrastructure/render/human-renderer.ts";

export const buildSpec: CommandSpec = {
  name: "build",
  summary: "Index every source into the corpus",
  usage: "graphdog build [--corpus <name>] [--source <id>] [--incremental]",
  options: {
    source: { type: "string", multiple: true, description: "Only build these source ids (repeatable)", placeholder: "<id>" },
    incremental: { type: "boolean", description: "Only re-index files whose content changed" },
  },
  examples: ["graphdog build", "graphdog build --source docs"],
};

export const updateSpec: CommandSpec = {
  name: "update",
  summary: "Re-index only what changed since the last build",
  usage: "graphdog update [--corpus <name>] [--source <id>] [--full]",
  options: {
    source: { type: "string", multiple: true, description: "Only update these source ids (repeatable)", placeholder: "<id>" },
    full: { type: "boolean", description: "Re-index everything, ignoring content hashes" },
  },
  examples: ["graphdog update"],
};

export async function runBuild(context: CommandContext, full: boolean): Promise<CommandResult> {
  const explicitFull = optionBoolean(context.parsed, "full");
  const incremental = optionBoolean(context.parsed, "incremental");
  const onlySources = optionList(context.parsed, "source");

  const contextOptions = {
    ...(optionSingleCorpus(context.parsed, "build") === undefined
      ? {}
      : { corpus: optionSingleCorpus(context.parsed, "build") as string }),
    cwd: context.cwd,
    logger: context.logger,
  };

  const corpus = await openCorpus(contextOptions);
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
