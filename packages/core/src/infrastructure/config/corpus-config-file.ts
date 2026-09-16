/**
 * Reading and writing `graphdog.json`.
 *
 * JSON rather than TOML or YAML: Node parses and emits it with no dependency,
 * every agent and editor can already read it, and it round-trips exactly. A
 * config format that needs a parser dependency is a poor trade for a tool whose
 * selling point is that it installs in seconds.
 *
 * Parsing is strict about what it validates and permissive about what it
 * ignores: an unknown key is left alone (so a newer GraphDog's config still
 * loads), but a *wrong* value fails loudly rather than silently reverting to a
 * default the user did not ask for.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { ConfigError } from "../../domain/errors.ts";
import { DEFAULT_CHUNKING } from "../../domain/service/chunker.ts";
import { DEFAULT_FUSION, type FusionStrategy } from "../../domain/service/fusion.ts";
import { DEFAULT_GRAPH_RULES } from "../../domain/service/graph-builder.ts";
import {
  DEFAULT_EMBEDDING,
  DEFAULT_RERANK,
  DEFAULT_SEARCH,
  type CorpusConfig,
} from "../../application/config.ts";
import { normalizeSourceSpec } from "../source/source-reader-factory.ts";

export const CONFIG_FILENAME = "graphdog.json";

/** Bumped when the config file's shape changes incompatibly. */
export const CONFIG_VERSION = 1;

export async function loadCorpusConfig(path: string): Promise<CorpusConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`config file not found: ${path}`, { cause: String(error) });
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`invalid JSON in ${path}: ${String(error)}`, { path });
  }
  return parseCorpusConfig(data, path);
}

export async function saveCorpusConfig(path: string, config: CorpusConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatCorpusConfig(config), "utf8");
}

/**
 * The config file's exact text.
 *
 * One formatter for the file on disk and the copy inside an archive, so an
 * exported config is byte-for-byte what `graphdog init` would have written.
 */
export function formatCorpusConfig(config: CorpusConfig): string {
  return `${JSON.stringify(serializeCorpusConfig(config), null, 2)}\n`;
}

export function parseCorpusConfig(input: unknown, path = "<config>"): CorpusConfig {
  const data = asObject(input, path);

  const version = asNumber(data["version"], CONFIG_VERSION, `${path}.version`);
  if (version > CONFIG_VERSION) {
    throw new ConfigError(
      `config version ${version} is newer than this GraphDog understands (${CONFIG_VERSION}); ` +
        `upgrade GraphDog`,
      { path },
    );
  }

  const name = asString(data["name"], "", `${path}.name`);
  if (name === "") throw new ConfigError(`${path} is missing "name"`, { path });

  const embeddingRaw = asObject(data["embedding"] ?? {}, `${path}.embedding`);
  const provider = asString(embeddingRaw["provider"], DEFAULT_EMBEDDING.provider, `${path}.embedding.provider`);
  if (provider !== "hash" && provider !== "transformers") {
    throw new ConfigError(`unknown embedding provider "${provider}"`, {
      supported: ["hash", "transformers"],
      path,
    });
  }

  const fusionRaw = asObject(data["fusion"] ?? {}, `${path}.fusion`);
  const strategy = asString(fusionRaw["strategy"], DEFAULT_FUSION.strategy, `${path}.fusion.strategy`);
  if (strategy !== "rrf" && strategy !== "weighted") {
    throw new ConfigError(`unknown fusion strategy "${strategy}"`, {
      supported: ["rrf", "weighted"],
      path,
    });
  }

  const chunkingRaw = asObject(data["chunking"] ?? {}, `${path}.chunking`);
  const graphRaw = asObject(data["graph"] ?? {}, `${path}.graph`);
  const searchRaw = asObject(data["search"] ?? {}, `${path}.search`);
  const rerankRaw = asObject(data["rerank"] ?? {}, `${path}.rerank`);

  const sourcesRaw = data["sources"] ?? [];
  if (!Array.isArray(sourcesRaw)) {
    throw new ConfigError(`${path}.sources must be an array`, { path });
  }
  const sources = sourcesRaw.map((entry, index) => {
    const source = asObject(entry, `${path}.sources[${index}]`);
    return normalizeSourceSpec({
      id: asString(source["id"], "", `${path}.sources[${index}].id`),
      kind: asString(source["kind"], "local", `${path}.sources[${index}].kind`),
      uri: asString(source["uri"], "", `${path}.sources[${index}].uri`),
      include: asStringArray(source["include"], `${path}.sources[${index}].include`),
      exclude: asStringArray(source["exclude"], `${path}.sources[${index}].exclude`),
      ...(source["maxFileBytes"] === undefined
        ? {}
        : { maxFileBytes: asNumber(source["maxFileBytes"], 0, `${path}.sources[${index}].maxFileBytes`) }),
      followSymlinks: asBoolean(source["followSymlinks"], false, `${path}.sources[${index}].followSymlinks`),
      indexSecrets: asBoolean(source["indexSecrets"], false, `${path}.sources[${index}].indexSecrets`),
    });
  });

  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) {
      throw new ConfigError(`duplicate source id "${source.id}"`, { path });
    }
    seen.add(source.id);
  }

  return {
    name,
    description: asString(data["description"], "", `${path}.description`),
    sources,
    embedding: {
      provider,
      model: data["embedding"] === undefined ? null : asNullableString(embeddingRaw["model"]),
      dimensions: asNumber(embeddingRaw["dimensions"], DEFAULT_EMBEDDING.dimensions, `${path}.embedding.dimensions`),
      batchSize: asNumber(embeddingRaw["batchSize"], DEFAULT_EMBEDDING.batchSize, `${path}.embedding.batchSize`),
    },
    rerank: {
      enabled: asBoolean(rerankRaw["enabled"], DEFAULT_RERANK.enabled, `${path}.rerank.enabled`),
      provider: "transformers",
      model: asString(rerankRaw["model"], DEFAULT_RERANK.model, `${path}.rerank.model`),
      topK: asNumber(rerankRaw["topK"], DEFAULT_RERANK.topK, `${path}.rerank.topK`),
    },
    chunking: {
      maxChars: asNumber(chunkingRaw["maxChars"], DEFAULT_CHUNKING.maxChars, `${path}.chunking.maxChars`),
      overlapChars: asNumber(chunkingRaw["overlapChars"], DEFAULT_CHUNKING.overlapChars, `${path}.chunking.overlapChars`),
      minChars: asNumber(chunkingRaw["minChars"], DEFAULT_CHUNKING.minChars, `${path}.chunking.minChars`),
      respectHeadings: asBoolean(chunkingRaw["respectHeadings"], DEFAULT_CHUNKING.respectHeadings, `${path}.chunking.respectHeadings`),
    },
    fusion: {
      strategy: strategy as FusionStrategy,
      denseWeight: asNumber(fusionRaw["denseWeight"], DEFAULT_FUSION.denseWeight, `${path}.fusion.denseWeight`),
      bm25Weight: asNumber(fusionRaw["bm25Weight"], DEFAULT_FUSION.bm25Weight, `${path}.fusion.bm25Weight`),
      graphWeight: asNumber(fusionRaw["graphWeight"], DEFAULT_FUSION.graphWeight, `${path}.fusion.graphWeight`),
      rrfK: asNumber(fusionRaw["rrfK"], DEFAULT_FUSION.rrfK, `${path}.fusion.rrfK`),
    },
    graph: {
      enableLinks: asBoolean(graphRaw["enableLinks"], DEFAULT_GRAPH_RULES.enableLinks, `${path}.graph.enableLinks`),
      enableTags: asBoolean(graphRaw["enableTags"], DEFAULT_GRAPH_RULES.enableTags, `${path}.graph.enableTags`),
      enableDirectories: asBoolean(graphRaw["enableDirectories"], DEFAULT_GRAPH_RULES.enableDirectories, `${path}.graph.enableDirectories`),
      enableSimilarity: asBoolean(graphRaw["enableSimilarity"], DEFAULT_GRAPH_RULES.enableSimilarity, `${path}.graph.enableSimilarity`),
      similarityThreshold: asNumber(graphRaw["similarityThreshold"], DEFAULT_GRAPH_RULES.similarityThreshold, `${path}.graph.similarityThreshold`),
      maxGroupSize: asNumber(graphRaw["maxGroupSize"], DEFAULT_GRAPH_RULES.maxGroupSize, `${path}.graph.maxGroupSize`),
    },
    search: {
      topK: asNumber(searchRaw["topK"], DEFAULT_SEARCH.topK, `${path}.search.topK`),
      candidateMultiplier: asNumber(searchRaw["candidateMultiplier"], DEFAULT_SEARCH.candidateMultiplier, `${path}.search.candidateMultiplier`),
      graphHops: asNumber(searchRaw["graphHops"], DEFAULT_SEARCH.graphHops, `${path}.search.graphHops`),
      exploreHops: asNumber(searchRaw["exploreHops"], DEFAULT_SEARCH.exploreHops, `${path}.search.exploreHops`),
      minScore: asNumber(searchRaw["minScore"], DEFAULT_SEARCH.minScore, `${path}.search.minScore`),
      minTermCoverage: asNumber(
        searchRaw["minTermCoverage"],
        DEFAULT_SEARCH.minTermCoverage,
        `${path}.search.minTermCoverage`,
      ),
      minDenseSimilarity:
        searchRaw["minDenseSimilarity"] === undefined || searchRaw["minDenseSimilarity"] === null
          ? null
          : asNumber(searchRaw["minDenseSimilarity"], 0, `${path}.search.minDenseSimilarity`),
      snippetChars: asNumber(searchRaw["snippetChars"], DEFAULT_SEARCH.snippetChars, `${path}.search.snippetChars`),
      enableGraph: asBoolean(searchRaw["enableGraph"], DEFAULT_SEARCH.enableGraph, `${path}.search.enableGraph`),
      enableDense: asBoolean(searchRaw["enableDense"], DEFAULT_SEARCH.enableDense, `${path}.search.enableDense`),
      enableLexical: asBoolean(searchRaw["enableLexical"], DEFAULT_SEARCH.enableLexical, `${path}.search.enableLexical`),
    },
  };
}

/** Serialize, omitting anything still at its default so the file stays readable. */
export function serializeCorpusConfig(config: CorpusConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    version: CONFIG_VERSION,
    name: config.name,
  };
  if (config.description !== "") out["description"] = config.description;

  out["sources"] = config.sources.map((source) => {
    const entry: Record<string, unknown> = { id: source.id, kind: source.kind, uri: source.uri };
    if (source.include.length > 0) entry["include"] = [...source.include];
    if (source.exclude.length > 0) entry["exclude"] = [...source.exclude];
    if (source.followSymlinks) entry["followSymlinks"] = true;
    if (source.indexSecrets) entry["indexSecrets"] = true;
    return entry;
  });

  const embedding = diff(config.embedding, DEFAULT_EMBEDDING);
  if (Object.keys(embedding).length > 0) out["embedding"] = embedding;
  const rerank = diff(config.rerank, DEFAULT_RERANK);
  if (Object.keys(rerank).length > 0) out["rerank"] = rerank;
  const chunking = diff(config.chunking, DEFAULT_CHUNKING);
  if (Object.keys(chunking).length > 0) out["chunking"] = chunking;
  const fusion = diff(config.fusion, DEFAULT_FUSION);
  if (Object.keys(fusion).length > 0) out["fusion"] = fusion;
  const graph = diff(config.graph, DEFAULT_GRAPH_RULES);
  if (Object.keys(graph).length > 0) out["graph"] = graph;
  const search = diff(config.search, DEFAULT_SEARCH);
  if (Object.keys(search).length > 0) out["search"] = search;
  return out;
}

/** Keys whose value differs from the default, so the file records only choices. */
function diff<T extends object>(actual: T, defaults: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const baseline = defaults as Record<string, unknown>;
  for (const [key, value] of Object.entries(actual)) {
    if (value !== baseline[key]) out[key] = value;
  }
  return out;
}

// --- typed accessors ---------------------------------------------------------
// Each reports the exact path of a bad value, so a config error names the line
// to fix rather than just the file.

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`, { got: typeof value });
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback: string, path: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new ConfigError(`${path} must be a string`, { got: typeof value });
  return value;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a finite number`, { got: value });
  }
  return value;
}

function asBoolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be a boolean`, { got: typeof value });
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ConfigError(`${path} must be an array of strings`, {});
  }
  return value as string[];
}
