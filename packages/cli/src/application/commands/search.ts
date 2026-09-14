/**
 * `graphdog search` and `graphdog explore`.
 *
 * Both call the same pipeline; `explore` additionally returns the graph
 * neighbourhood around the results. Sharing the pipeline is what guarantees the
 * two never disagree about which document is most relevant.
 *
 * `--corpus` is repeatable and `--all` searches everything visible. One corpus
 * takes the single-corpus path unchanged; several are merged by rank, and any
 * that could not be opened are reported rather than quietly dropped.
 */

import {
  ExitCode,
  UsageError,
  assertCompatible,
  discoverCorpusNames,
  openCorpus,
  envelope,
  exploreCorpus,
  openCorpora,
  searchCorpora,
  searchCorpus,
  toEdgeDto,
  toFreshnessDto,
  toHitDto,
  toNodeDto,
  toWarningDtos,
  type CorpusContext,
  type CorpusTarget,
  type ExploreResponseDto,
  type GraphEdgeDto,
  type GraphNodeDto,
  type SearchDependencies,
  type SearchOptions,
  type SearchResponseDto,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import {
  optionBoolean,
  optionCorpora,
  optionList,
  optionNumber,
  type CommandSpec,
} from "../../infrastructure/argv.ts";
import { renderExplore, renderSearch } from "../../infrastructure/render/human-renderer.ts";

const sharedOptions: CommandSpec["options"] = {
  "top-k": { type: "string", short: "k", description: "Maximum results to return", placeholder: "<n>" },
  "min-score": { type: "string", description: "Drop results below this fused score (0-1)", placeholder: "<n>" },
  hops: { type: "string", description: "Graph expansion depth; 0 disables the graph", placeholder: "<n>" },
  all: { type: "boolean", short: "a", description: "Search every corpus visible from here" },
  rerank: { type: "boolean", description: "Re-score the shortlist with a cross-encoder" },
  "no-rerank": { type: "boolean", description: "Skip reranking even if the corpus enables it" },
  source: { type: "string", multiple: true, description: "Restrict results to these source ids (repeatable)", placeholder: "<id>" },
};

export const searchSpec: CommandSpec = {
  name: "search",
  summary: "Find evidence for a question",
  usage: 'graphdog search "<query>" [--corpus <name>]... [--all] [--top-k <n>] [--json]',
  options: sharedOptions,
  examples: [
    'graphdog search "JWT rotation"',
    'graphdog search "認証設計" --json --top-k 5',
    'graphdog search "key rotation" --corpus docs --corpus runbooks',
    'graphdog search "onboarding" --all',
  ],
};

export const exploreSpec: CommandSpec = {
  name: "explore",
  summary: "Search, and return the graph neighbourhood of the results",
  usage: 'graphdog explore "<query>" [--corpus <name>]... [--hops <n>] [--json]',
  options: sharedOptions,
  examples: ['graphdog explore "access token" --hops 3'],
};

export async function runSearch(
  context: CommandContext,
  mode: "search" | "explore",
): Promise<CommandResult> {
  const query = context.parsed.positionals.join(" ").trim();
  if (query === "") {
    throw new UsageError(`${mode}: a query is required`, {
      usage: mode === "search" ? searchSpec.usage : exploreSpec.usage,
    });
  }

  const options: SearchOptions = {
    query,
    ...numeric("topK", optionNumber(context.parsed, "top-k", mode)),
    ...numeric("minScore", optionNumber(context.parsed, "min-score", mode)),
    ...numeric("hops", optionNumber(context.parsed, "hops", mode)),
    ...rerankChoice(context),
    ...filterPrefixes(context),
  };

  const names = await resolveTargetNames(context);
  return names.length > 1
    ? runAcrossCorpora(context, mode, options, names)
    : runSingleCorpus(context, mode, options, names[0]);
}

/**
 * Which corpora to search.
 *
 * `--all` and repeated `--corpus` are additive; with neither, an empty list
 * means "let the workspace decide", which is how a single-corpus project needs
 * no flags at all.
 */
async function resolveTargetNames(context: CommandContext): Promise<string[]> {
  const explicit = optionCorpora(context.parsed);
  if (optionBoolean(context.parsed, "all")) {
    const discovered = await discoverCorpusNames(context.cwd);
    if (discovered.length === 0) {
      throw new UsageError("--all found no corpora; run 'graphdog init' first");
    }
    return [...new Set([...explicit, ...discovered])];
  }
  return explicit;
}

// --- one corpus --------------------------------------------------------------

async function runSingleCorpus(
  context: CommandContext,
  mode: "search" | "explore",
  options: SearchOptions,
  name: string | undefined,
): Promise<CommandResult> {
  const corpus = await openForQuery(context, name);
  try {
    const dependencies = await dependenciesFor(corpus);

    if (mode === "explore") {
      const outcome = await exploreCorpus(options, dependencies);
      const response: ExploreResponseDto = {
        ...envelope("explore"),
        query: outcome.query,
        corpus: outcome.corpus,
        corpora: outcome.corpora,
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
      ...envelope("search"),
      query: outcome.query,
      corpus: outcome.corpus,
      corpora: outcome.corpora,
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
async function openForQuery(
  context: CommandContext,
  name: string | undefined,
): Promise<CorpusContext> {
  const corpus = await openCorpus({
    ...(name === undefined ? {} : { corpus: name }),
    cwd: context.cwd,
    logger: context.logger,
  });
  try {
    assertCompatible(corpus.store, corpus.config, corpus.embedding);
    return corpus;
  } catch (error) {
    corpus.close();
    throw error;
  }
}

// --- several corpora ---------------------------------------------------------

async function runAcrossCorpora(
  context: CommandContext,
  mode: "search" | "explore",
  options: SearchOptions,
  names: readonly string[],
): Promise<CommandResult> {
  const opened = await openCorpora(names, { cwd: context.cwd, logger: context.logger });

  try {
    const targets: CorpusTarget[] = [];
    for (const entry of opened) {
      targets.push(
        entry.context === null
          ? {
              name: entry.name,
              scope: entry.scope,
              unavailable: entry.unavailable,
              // Never read: `searchCorpora` short-circuits on `unavailable`.
              dependencies: undefined as never,
            }
          : {
              name: entry.name,
              scope: entry.scope,
              unavailable: null,
              dependencies: await dependenciesFor(entry.context),
            },
      );
    }

    const outcome = await searchCorpora(options, { targets, logger: context.logger });

    // Explore's neighbourhood is per corpus, so it is gathered from each corpus
    // that contributed a hit rather than from one graph.
    let nodes: GraphNodeDto[] = [];
    let edges: GraphEdgeDto[] = [];
    if (mode === "explore") {
      for (const entry of opened) {
        if (entry.context === null) continue;
        const refs = outcome.topRefsByCorpus.get(entry.name) ?? [];
        if (refs.length === 0) continue;
        const neighbourhood = entry.context.store.graph.neighborhood(refs, 200);
        nodes = [...nodes, ...neighbourhood.nodes.map(toNodeDto)];
        edges = [...edges, ...neighbourhood.edges.map(toEdgeDto)];
      }
    }

    const base = {
      query: outcome.query,
      corpus: outcome.corpus,
      corpora: outcome.corpora,
      freshness: toFreshnessDto(outcome.freshness),
      hits: outcome.hits.map(toHitDto),
      suggested_queries: outcome.suggestedQueries,
      strategy: outcome.strategy,
      stats: outcome.stats,
      warnings: toWarningDtos(outcome.warnings),
    };

    if (mode === "explore") {
      const response: ExploreResponseDto = { ...envelope("explore"), ...base, nodes, edges };
      return {
        json: response,
        human: renderExplore(response),
        ...(outcome.noEvidence ? { exitCode: ExitCode.NO_EVIDENCE } : {}),
      };
    }

    const response: SearchResponseDto = { ...envelope("search"), ...base };
    return {
      json: response,
      human: renderSearch(response),
      ...(outcome.noEvidence ? { exitCode: ExitCode.NO_EVIDENCE } : {}),
    };
  } finally {
    for (const entry of opened) entry.context?.close();
  }
}

// --- shared plumbing ---------------------------------------------------------

/**
 * Assemble search dependencies from an open corpus.
 *
 * One place, so the single-corpus and cross-corpus paths cannot drift in what
 * they hand the pipeline.
 */
async function dependenciesFor(corpus: CorpusContext): Promise<SearchDependencies> {
  return {
    store: corpus.store,
    config: corpus.config,
    embedding: corpus.embedding,
    freshness: corpus.freshness(),
    reranker: await corpus.reranker(),
    logger: corpus.logger,
  };
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
