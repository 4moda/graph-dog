/**
 * `graphdog status` and `graphdog list`.
 *
 * `status` is the call an agent should make before trusting a corpus: it
 * reports compatibility and freshness as data, not as an error, because
 * "this corpus is unusable and here is why" is exactly what it exists to say.
 */

import {
  envelope,
  describeCorpus,
  listCorpusNames,
  openCorpus,
  readCorpusConfig,
  resolveCorpus,
  toFreshnessDto,
  toWarningDtos,
  visibleWorkspaces,
  type CorpusInfoDto,
  type CorpusListDto,
  type CorpusListEntryDto,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import { optionSingleCorpus, type CommandSpec } from "../../infrastructure/argv.ts";
import { renderCorpusList, renderStatus } from "../../infrastructure/render/human-renderer.ts";

export const statusSpec: CommandSpec = {
  name: "status",
  summary: "Report what a corpus contains and whether it can be trusted",
  usage: "graphdog status [--corpus <name>] [--json]",
  options: {},
  examples: ["graphdog status", "graphdog status --json"],
};

export const listSpec: CommandSpec = {
  name: "list",
  summary: "List every corpus visible from here",
  usage: "graphdog list [--json]",
  options: {},
  examples: ["graphdog list"],
};

export async function runStatus(context: CommandContext): Promise<CommandResult> {
  const name = optionSingleCorpus(context.parsed, "status");
  const corpus = await openCorpus({
    ...(name === undefined ? {} : { corpus: name }),
    cwd: context.cwd,
    logger: context.logger,
  });

  try {
    const outcome = describeCorpus({
      store: corpus.store,
      config: corpus.config,
      hasher: corpus.hasher,
      path: corpus.storePath,
      scope: corpus.scope,
      sources: corpus.sources,
    });

    const info: CorpusInfoDto = {
      ...envelope("corpus_info"),
      name: outcome.name,
      path: outcome.path,
      scope: outcome.scope,
      corpus_schema_version: outcome.corpusSchemaVersion,
      embedding: outcome.embedding,
      chunking: outcome.chunking,
      counts: outcome.counts,
      freshness: toFreshnessDto(outcome.freshness),
      sources: outcome.sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        uri: source.uri,
        revision: source.revision,
        document_count: source.documentCount,
      })),
      compatible: outcome.compatible,
      incompatibility: outcome.incompatibility,
      warnings: toWarningDtos(outcome.warnings),
    };

    return { json: info, human: renderStatus(info) };
  } finally {
    corpus.close();
  }
}

export async function runList(context: CommandContext): Promise<CommandResult> {
  const workspaces = await visibleWorkspaces(context.cwd);
  const corpora: CorpusListEntryDto[] = [];
  const warnings: Array<{ code: string; message: string; details?: Record<string, unknown> }> = [];

  for (const workspace of workspaces) {
    for (const name of await listCorpusNames(workspace)) {
      try {
        const resolved = await resolveCorpus(name, context.cwd);
        const config = await readCorpusConfig(resolved);
        const corpus = await openCorpus({ corpus: name, cwd: context.cwd, logger: context.logger });
        try {
          const outcome = describeCorpus({
            store: corpus.store,
            config,
            hasher: corpus.hasher,
            path: corpus.storePath,
            scope: corpus.scope,
          });
          corpora.push({
            name: outcome.name,
            scope: workspace.scope,
            path: outcome.path,
            document_count: outcome.counts["documents"] ?? 0,
            chunk_count: outcome.counts["chunks"] ?? 0,
            built_at: outcome.freshness.builtAt,
            compatible: outcome.compatible,
            description: config.description,
          });
        } finally {
          corpus.close();
        }
      } catch (error) {
        // One unreadable corpus must not hide the rest of the list; it is
        // reported as a warning so the gap is visible rather than silent.
        warnings.push({
          code: "corpus_unreadable",
          message: `could not read corpus "${name}": ${String(error)}`,
          details: { corpus: name, workspace: workspace.root },
        });
      }
    }
  }

  const list: CorpusListDto = {
    ...envelope("corpus_list"),
    corpora,
    warnings: toWarningDtos(warnings),
  };

  return { json: list, human: renderCorpusList(list) };
}
