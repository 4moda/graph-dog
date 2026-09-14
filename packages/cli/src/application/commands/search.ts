/**
 * `graphdog search` and `graphdog explore`.
 *
 * Both call the same pipeline; `explore` additionally returns the graph
 * neighbourhood around the results. Sharing the pipeline is what guarantees the
 * two never disagree about which document is most relevant.
 */

import {
  ExitCode,
  UsageError,
  assertCompatible,
  exploreCorpus,
  openCorpus,
  searchCorpus,
  toHitDto,
  toFreshnessDto,
  toNodeDto,
  toEdgeDto,
  toWarningDtos,
  type CorpusContext,
  type ExploreResponseDto,
  type SearchResponseDto,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import {
  optionBoolean,
  optionList,
  optionNumber,
  optionString,
  type CommandSpec,
} from "../../infrastructure/argv.ts";
import { renderExplore, renderSearch } from "../../infrastructure/render/human-renderer.ts";

const sharedOptions: CommandSpec["options"] = {
  "top-k": { type: "string", short: "k", description: "Maximum results to return", placeholder: "<n>" },
  "min-score": { type: "string", description: "Drop results below this fused score (0-1)", placeholder: "<n>" },
  hops: { type: "string", description: "Graph expansion depth; 0 disables the graph", placeholder: "<n>" },
  rerank: { type: "boolean", description: "Re-score the shortlist with a cross-encoder" },
  "no-rerank": { type: "boolean", description: "Skip reranking even if the corpus enables it" },
  source: { type: "string", multiple: true, description: "Restrict results to these source ids (repeatable)", placeholder: "<id>" },
};

export const searchSpec: CommandSpec = {
  name: "search",
  summary: "Find evidence for a question",
  usage: 'graphdog search "<query>" [--top-k <n>] [--json]',
  options: sharedOptions,
  examples: [
    'graphdog search "JWT rotation"',
    'graphdog search "認証設計" --json --top-k 5',
  ],
};

export const exploreSpec: CommandSpec = {
  name: "explore",
  summary: "Search, and return the graph neighbourhood of the results",
  usage: 'graphdog explore "<query>" [--hops <n>] [--json]',
  options: sharedOptions,
  examples: ['graphdog explore "access token" --hops 3'],
};

export async function runSearch(context: CommandContext, mode: "search" | "explore"): Promise<CommandResult> {
  const query = context.parsed.positionals.join(" ").trim();
  if (query === "") {
    throw new UsageError(`${mode}: a query is required`, {
      usage: mode === "search" ? searchSpec.usage : exploreSpec.usage,
    });
  }

  const corpus = await openCorpusForQuery(context);
  try {
    const options = {
      query,
      ...numeric("topK", optionNumber(context.parsed, "top-k", mode)),
      ...numeric("minScore", optionNumber(context.parsed, "min-score", mode)),
      ...numeric("hops", optionNumber(context.parsed, "hops", mode)),
      ...rerankChoice(context),
      ...filterPrefixes(context),
    };

    const dependencies = {
      store: corpus.store,
      config: corpus.config,
      embedding: corpus.embedding,
      freshness: corpus.freshness(),
      reranker: await corpus.reranker(),
      logger: corpus.logger,
    };

    if (mode === "explore") {
      const outcome = await exploreCorpus(options, dependencies);
      const response: ExploreResponseDto = {
        schema_version: "1",
        contract_version: "1.0",
        kind: "explore",
        query: outcome.query,
        corpus: outcome.corpus,
        freshness: toFreshnessDto(outcome.freshness),
        hits: outcome.hits.map(toHitDto),
        nodes: outcome.nodes.map(toNodeDto),
        edges: outcome.edges.map(toEdgeDto),
        suggested_queries: outcome.suggestedQueries,
        strategy: outcome.strategy,
        stats: outcome.stats,
        warnings: toWarningDtos(outcome.warnings),
      };
      return {
        json: response,
        human: renderExplore(response),
        ...(outcome.noEvidence ? { exitCode: ExitCode.NO_EVIDENCE } : {}),
      };
    }

    const outcome = await searchCorpus(options, dependencies);
    const response: SearchResponseDto = {
      schema_version: "1",
      contract_version: "1.0",
      kind: "search",
      query: outcome.query,
      corpus: outcome.corpus,
      freshness: toFreshnessDto(outcome.freshness),
      hits: outcome.hits.map(toHitDto),
      suggested_queries: outcome.suggestedQueries,
      strategy: outcome.strategy,
      stats: outcome.stats,
      warnings: toWarningDtos(outcome.warnings),
    };
    return {
      json: response,
      human: renderSearch(response),
      // "Nothing matched" gets its own exit code so a caller can branch on it
      // without inspecting the payload.
      ...(outcome.noEvidence ? { exitCode: ExitCode.NO_EVIDENCE } : {}),
    };
  } finally {
    corpus.close();
  }
}

/** Open the corpus and refuse to query it if its stored identities do not match. */
async function openCorpusForQuery(context: CommandContext): Promise<CorpusContext> {
  const name = optionString(context.parsed, "corpus");
  const corpus = await openCorpus({
    ...(name === undefined ? {} : { corpus: name }),
    cwd: context.cwd,
    logger: context.logger,
  });
  try {
    assertCompatible(corpus.store, corpus.config, corpus.embedding);
  } catch (error) {
    corpus.close();
    throw error;
  }
  return corpus;
}

function numeric<K extends string>(key: K, value: number | undefined): Record<K, number> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

function rerankChoice(context: CommandContext): { rerank?: boolean } {
  if (optionBoolean(context.parsed, "no-rerank")) return { rerank: false };
  if (optionBoolean(context.parsed, "rerank")) return { rerank: true };
  return {};
}

function filterPrefixes(context: CommandContext): { filterPrefixes?: string[] } {
  const sources = optionList(context.parsed, "source");
  return sources.length === 0 ? {} : { filterPrefixes: sources.map((id) => `${id}/`) };
}
