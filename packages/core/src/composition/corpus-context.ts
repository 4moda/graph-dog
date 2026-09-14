/**
 * The composition root: where interfaces meet implementations.
 *
 * This is the only module that knows about both layers at once. The CLI and the
 * MCP server each open a context and call use cases; neither constructs an
 * adapter, and neither can therefore drift from the other in how a corpus is
 * assembled -- which is what makes their results identical rather than merely
 * similar.
 */

import { readFile } from "node:fs/promises";

import { IncompatibleCorpusError, toGraphDogError } from "../domain/errors.ts";
import { compareStrings } from "../domain/ordering.ts";
import { checkIdentity, SCHEMA_VERSION } from "../domain/model/corpus-identity.ts";
import { chunkingFingerprint } from "../domain/service/chunker.ts";
import type { CorpusConfig } from "../application/config.ts";
import { CORPUS_META_KEYS } from "../application/corpus-meta.ts";
import type { CorpusStore } from "../application/ports/repositories.ts";
import type { EmbeddingModel, Reranker } from "../application/ports/models.ts";
import type { ExtractorRegistry, SourceReader } from "../application/ports/sources.ts";
import type { Clock, Hasher, Logger } from "../application/ports/system.ts";
import { SILENT_LOGGER } from "../application/ports/system.ts";
import { corpusFreshness } from "../application/usecase/describe-corpus.ts";
import type { Freshness } from "../domain/model/freshness.ts";
import { DefaultExtractorRegistry } from "../infrastructure/extraction/extractor-registry.ts";
import { HashingEmbeddingModel } from "../infrastructure/embedding/hashing-embedding-model.ts";
import { TransformersEmbeddingModel } from "../infrastructure/embedding/transformers-embedding-model.ts";
import { TransformersReranker } from "../infrastructure/rerank/transformers-reranker.ts";
import { SqliteCorpusStore } from "../infrastructure/persistence/sqlite/sqlite-corpus-store.ts";
import { buildSourceReader } from "../infrastructure/source/source-reader-factory.ts";
import { sha256Hasher, systemClock } from "../infrastructure/system-adapters.ts";
import {
  listCorpusNames,
  readCorpusConfig,
  resolveCorpus,
  resolveSourceUri,
  visibleWorkspaces,
  type ResolvedCorpus,
} from "../infrastructure/config/workspace.ts";

export interface CorpusContext {
  readonly name: string;
  readonly config: CorpusConfig;
  readonly store: CorpusStore;
  readonly embedding: EmbeddingModel;
  readonly extractors: ExtractorRegistry;
  readonly sources: SourceReader[];
  readonly clock: Clock;
  readonly hasher: Hasher;
  readonly logger: Logger;
  readonly storePath: string;
  readonly scope: string;
  readonly readFile: (absolutePath: string) => Promise<Uint8Array>;
  /** Loaded lazily: a reranker costs a model load, so only pay when used. */
  reranker(): Promise<Reranker | null>;
  freshness(): Freshness;
  close(): void;
}

export interface OpenCorpusOptions {
  readonly corpus?: string;
  readonly cwd?: string;
  readonly logger?: Logger;
  /** Refuse to run if the corpus cannot be searched as it stands. */
  readonly requireCompatible?: boolean;
  /** Skip loading source adapters; used by read-only paths that never touch disk. */
  readonly withoutSources?: boolean;
}

export async function openCorpus(options: OpenCorpusOptions = {}): Promise<CorpusContext> {
  const resolved = await resolveCorpus(options.corpus, options.cwd);
  const config = await readCorpusConfig(resolved);
  return openResolvedCorpus(resolved, config, options);
}

export async function openResolvedCorpus(
  resolved: ResolvedCorpus,
  config: CorpusConfig,
  options: OpenCorpusOptions = {},
): Promise<CorpusContext> {
  const logger = options.logger ?? SILENT_LOGGER;
  const store = await SqliteCorpusStore.open(resolved.storePath);

  try {
    const embedding = await createEmbeddingModel(config);
    const extractors = new DefaultExtractorRegistry();
    const supported = extractors.supportedExtensions();

    const sources = options.withoutSources === true
      ? []
      : config.sources.map((spec) =>
          buildSourceReader(
            { ...spec, uri: resolveSourceUri(resolved.workspace, spec.uri) },
            supported,
          ),
        );

    if (options.requireCompatible === true) {
      assertCompatible(store, config, embedding);
    }

    let rerankerPromise: Promise<Reranker | null> | null = null;

    return {
      name: resolved.name,
      config,
      store,
      embedding,
      extractors,
      sources,
      clock: systemClock,
      hasher: sha256Hasher,
      logger,
      storePath: resolved.storePath,
      scope: resolved.workspace.scope,
      readFile: async (absolutePath) => new Uint8Array(await readFile(absolutePath)),

      reranker() {
        rerankerPromise ??= loadReranker(config, logger);
        return rerankerPromise;
      },

      freshness() {
        return corpusFreshness({ store, config, hasher: sha256Hasher, path: resolved.storePath, scope: resolved.workspace.scope, sources });
      },

      close() {
        store.close();
      },
    };
  } catch (error) {
    // A failure after the database is open would otherwise leak the handle and
    // leave a WAL file behind.
    store.close();
    throw error;
  }
}

export async function createEmbeddingModel(config: CorpusConfig): Promise<EmbeddingModel> {
  if (config.embedding.provider === "transformers") {
    return TransformersEmbeddingModel.load({
      ...(config.embedding.model === null ? {} : { model: config.embedding.model }),
      batchSize: config.embedding.batchSize,
    });
  }
  return new HashingEmbeddingModel(config.embedding.dimensions);
}

/**
 * Load the reranker, or report why there is none.
 *
 * A missing reranker is never fatal: search degrades to fusion order and
 * attaches a warning. Failing the whole query because an optional accuracy
 * improvement is unavailable would be the wrong trade.
 */
async function loadReranker(config: CorpusConfig, logger: Logger): Promise<Reranker | null> {
  if (!config.rerank.enabled) return null;
  try {
    return await TransformersReranker.load({ model: config.rerank.model });
  } catch (error) {
    logger.log("warn", "reranker unavailable; continuing without it", {
      model: config.rerank.model,
      error: String(error),
    });
    return null;
  }
}

/**
 * Refuse to search a corpus whose stored identities do not match the config.
 *
 * Vectors from a different model, or line ranges from a different chunker,
 * produce confident and wrong output. That is worth an error rather than a
 * warning, because nothing downstream can detect it.
 */
export function assertCompatible(
  store: CorpusStore,
  config: CorpusConfig,
  embedding: EmbeddingModel,
): void {
  if (store.meta.get(CORPUS_META_KEYS.builtAt) === null) {
    throw new IncompatibleCorpusError(
      `corpus "${config.name}" has not been built yet; run 'graphdog build'`,
      { corpus: config.name },
    );
  }

  const reason = checkIdentity(
    {
      schemaVersion: store.meta.get(CORPUS_META_KEYS.schemaVersion) ?? SCHEMA_VERSION,
      embeddingId: store.meta.get(CORPUS_META_KEYS.embeddingId) ?? undefined,
      chunkingFingerprint: store.meta.get(CORPUS_META_KEYS.chunkingFingerprint) ?? undefined,
      chunkingSchemaVersion: store.meta.get(CORPUS_META_KEYS.chunkingSchemaVersion) ?? "",
    },
    {
      embeddingId: embedding.id,
      chunkingFingerprint: chunkingFingerprint(sha256Hasher.hashText, config.chunking),
    },
  );

  if (reason !== null) {
    throw new IncompatibleCorpusError(reason.message, {
      corpus: config.name,
      field: reason.field,
      expected: reason.expected,
      actual: reason.actual,
      remedy: "graphdog build --full",
    });
  }
}

/**
 * Open several corpora for a cross-corpus search.
 *
 * A corpus that cannot be opened or is incompatible is *returned* as
 * unavailable rather than thrown: one broken corpus must not stop a search
 * across five, and the caller reports the gap instead of silently returning a
 * smaller answer that looks complete.
 */
export async function openCorpora(
  names: readonly string[],
  options: Omit<OpenCorpusOptions, "corpus"> = {},
): Promise<Array<{ name: string; scope: string; context: CorpusContext | null; unavailable: string | null }>> {
  const opened: Array<{
    name: string;
    scope: string;
    context: CorpusContext | null;
    unavailable: string | null;
  }> = [];

  for (const name of names) {
    let context: CorpusContext | null = null;
    try {
      context = await openCorpus({ ...options, corpus: name });
      assertCompatible(context.store, context.config, context.embedding);
      opened.push({ name, scope: context.scope, context, unavailable: null });
    } catch (error) {
      context?.close();
      opened.push({
        name,
        scope: "",
        context: null,
        unavailable: toGraphDogError(error).message,
      });
    }
  }
  return opened;
}

/** Every corpus name visible from `cwd`, across all workspaces. */
export async function discoverCorpusNames(cwd: string = process.cwd()): Promise<string[]> {
  const names = new Set<string>();
  for (const workspace of await visibleWorkspaces(cwd)) {
    for (const name of await listCorpusNames(workspace)) names.add(name);
  }
  return [...names].sort(compareStrings);
}
