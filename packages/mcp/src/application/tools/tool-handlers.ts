/**
 * Executing MCP tool calls.
 *
 * Every handler calls the same `@graphdog/core` use case the CLI calls, and
 * serializes through the same DTO mappers. That is the mechanism behind the
 * CLI/MCP equivalence guarantee: there is no second implementation that could
 * drift, only one pipeline with two front doors.
 */

import {
  ExitCode,
  UsageError,
  envelope,
  assertCompatible,
  discoverCorpusNames,
  openCorpora,
  searchCorpora,
  buildCorpus,
  describeCorpus,
  exploreCorpus,
  listCorpusNames,
  openCorpus,
  readCorpusConfig,
  readDocument,
  resolveCorpus,
  searchCorpus,
  toEdgeDto,
  toFreshnessDto,
  toHitDto,
  toLocationDto,
  toNodeDto,
  toWarningDtos,
  visibleWorkspaces,
  type BuildReportDto,
  type CorpusInfoDto,
  type CorpusListDto,
  type CorpusListEntryDto,
  type CorpusContext,
  type CorpusTarget,
  type ExploreResponseDto,
  type GraphEdgeDto,
  type GraphNodeDto,
  type SearchDependencies,
  type SearchOptions,
  type Logger,
  type ReadResponseDto,
  type SearchResponseDto,
} from "@graphdog/core";

export interface HandlerContext {
  readonly cwd: string;
  readonly logger: Logger;
  /** Corpus to use when a call omits one; overrides single-corpus auto-detection. */
  readonly defaultCorpus: string | undefined;
  readonly allowWrite: boolean;
}

export interface ToolOutcome {
  /** The contract object, returned verbatim as the tool's structured content. */
  readonly payload: unknown;
  /** True when the call succeeded but found nothing; not an error. */
  readonly empty?: boolean;
}

type Args = Record<string, unknown>;

export async function handleSearch(args: Args, context: HandlerContext): Promise<ToolOutcome> {
  const query = requireString(args, "query");
  const options: SearchOptions = {
    query,
    ...optionalNumber(args, "top_k", "topK"),
    ...optionalNumber(args, "min_score", "minScore"),
    ...optionalBoolean(args, "rerank", "rerank"),
    ...sourceFilter(args),
  };

  const names = await resolveTargetNames(args, context);
  if (names.length > 1) return searchAcross(names, options, context, "search");

  const corpus = await openForQuery(args, context);
  try {
    const outcome = await searchCorpus(options, await dependenciesFor(corpus));
    return {
      payload: {
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
      } satisfies SearchResponseDto,
      empty: outcome.noEvidence,
    };
  } finally {
    corpus.close();
  }
}

export async function handleExplore(args: Args, context: HandlerContext): Promise<ToolOutcome> {
  const query = requireString(args, "query");
  const options: SearchOptions = {
    query,
    ...optionalNumber(args, "top_k", "topK"),
    ...optionalNumber(args, "hops", "hops"),
  };

  const names = await resolveTargetNames(args, context);
  if (names.length > 1) return searchAcross(names, options, context, "explore");

  const corpus = await openForQuery(args, context);
  try {
    const outcome = await exploreCorpus(options, await dependenciesFor(corpus));
    return {
      payload: {
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
      } satisfies ExploreResponseDto,
      empty: outcome.noEvidence,
    };
  } finally {
    corpus.close();
  }
}

/**
 * Which corpora a call targets.
 *
 * `all_corpora` beats `corpora`, which beats `corpus`: the more explicit the
 * instruction, the more it wins. An empty list means "let the workspace
 * decide", which is how a single-corpus setup needs no argument at all.
 */
async function resolveTargetNames(args: Args, context: HandlerContext): Promise<string[]> {
  if (args["all_corpora"] === true) return discoverCorpusNames(context.cwd);

  const listed = args["corpora"];
  if (Array.isArray(listed)) {
    if (listed.some((entry) => typeof entry !== "string")) {
      throw new UsageError('"corpora" must be an array of corpus names', { received: listed });
    }
    if (listed.length > 0) return listed as string[];
  }

  const single = typeof args["corpus"] === "string" ? args["corpus"] : context.defaultCorpus;
  return single === undefined || single === "" ? [] : [single];
}

/** Search several corpora and merge by rank. */
async function searchAcross(
  names: readonly string[],
  options: SearchOptions,
  context: HandlerContext,
  mode: "search" | "explore",
): Promise<ToolOutcome> {
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

    let nodes: GraphNodeDto[] = [];
    let edges: GraphEdgeDto[] = [];
    if (mode === "explore") {
      // The neighbourhood is per corpus: each contributing corpus has its own
      // graph, and there is no edge between them to traverse.
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

    return {
      payload:
        mode === "explore"
          ? ({ ...envelope("explore"), ...base, nodes, edges } satisfies ExploreResponseDto)
          : ({ ...envelope("search"), ...base } satisfies SearchResponseDto),
      empty: outcome.noEvidence,
    };
  } finally {
    for (const entry of opened) entry.context?.close();
  }
}

export async function handleRead(args: Args, context: HandlerContext): Promise<ToolOutcome> {
  const ref = requireString(args, "ref");
  const corpus = await openCorpus({
    ...corpusOption(args, context),
    cwd: context.cwd,
    logger: context.logger,
    withoutSources: true,
  });

  try {
    const outcome = readDocument(
      {
        ref,
        ...optionalNumber(args, "start_line", "startLine"),
        ...optionalNumber(args, "end_line", "endLine"),
        ...optionalNumber(args, "max_chars", "maxChars"),
      },
      { store: corpus.store, corpusName: corpus.name },
    );

    const response: ReadResponseDto = {
      ...envelope("read"),
      corpus: outcome.corpus,
      ref: outcome.ref,
      title: outcome.title,
      text: outcome.text,
      location: toLocationDto(outcome.location),
      total_lines: outcome.totalLines,
      truncated: outcome.truncated,
      source_revision: outcome.sourceRevision,
      warnings: toWarningDtos(outcome.warnings),
    };
    return { payload: response };
  } finally {
    corpus.close();
  }
}

export async function handleStatus(args: Args, context: HandlerContext): Promise<ToolOutcome> {
  const corpus = await openCorpus({
    ...corpusOption(args, context),
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
    return { payload: info };
  } finally {
    corpus.close();
  }
}

export async function handleListCorpora(_args: Args, context: HandlerContext): Promise<ToolOutcome> {
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
        // One broken corpus must not hide the others: report the gap rather
        // than returning a short list that looks complete.
        warnings.push({
          code: "corpus_unreadable",
          message: `could not read corpus "${name}": ${String(error)}`,
          details: { corpus: name },
        });
      }
    }
  }

  const list: CorpusListDto = {
    ...envelope("corpus_list"),
    corpora,
    warnings: toWarningDtos(warnings),
  };
  return { payload: list };
}

export async function handleBuild(args: Args, context: HandlerContext): Promise<ToolOutcome> {
  if (!context.allowWrite) {
    throw new UsageError(
      "this GraphDog MCP server is read-only; restart it with --allow-write to build corpora",
      { tool: "build_corpus" },
    );
  }

  const corpus = await openCorpus({
    ...corpusOption(args, context),
    cwd: context.cwd,
    logger: context.logger,
  });

  try {
    const outcome = await buildCorpus(
      { full: args["full"] === true },
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
      warnings: toWarningDtos(outcome.warnings),
    };
    return { payload: report };
  } finally {
    corpus.close();
  }
}

// --- helpers -----------------------------------------------------------------

/**
 * Assemble search dependencies from an open corpus.
 *
 * One place, so the single-corpus and cross-corpus paths cannot drift in what
 * they hand the pipeline. The reranker is loaded here because `reranker()`
 * resolves to null immediately unless the corpus configures one, so the common
 * case costs nothing.
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

/** Open a corpus and refuse to query it if its stored identities do not match. */
async function openForQuery(args: Args, context: HandlerContext): Promise<CorpusContext> {
  const corpus = await openCorpus({
    ...corpusOption(args, context),
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

function corpusOption(args: Args, context: HandlerContext): { corpus?: string } {
  const requested = typeof args["corpus"] === "string" ? args["corpus"] : context.defaultCorpus;
  return requested === undefined || requested === "" ? {} : { corpus: requested };
}

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`"${key}" is required and must be a non-empty string`, { received: value });
  }
  return value;
}

function optionalNumber<K extends string>(
  args: Args,
  key: string,
  as: K,
): Record<K, number> | object {
  const value = args[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UsageError(`"${key}" must be a number`, { received: value });
  }
  return { [as]: value } as Record<K, number>;
}

function optionalBoolean<K extends string>(
  args: Args,
  key: string,
  as: K,
): Record<K, boolean> | object {
  const value = args[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "boolean") {
    throw new UsageError(`"${key}" must be a boolean`, { received: value });
  }
  return { [as]: value } as Record<K, boolean>;
}

function sourceFilter(args: Args): { filterPrefixes?: string[] } {
  const value = args["sources"];
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new UsageError('"sources" must be an array of source ids', { received: value });
  }
  const sources = value as string[];
  return sources.length === 0 ? {} : { filterPrefixes: sources.map((id) => `${id}/`) };
}

export { ExitCode };
