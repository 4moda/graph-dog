/**
 * Reporting what a corpus is and whether it can be trusted.
 *
 * `status` is the call an agent makes *before* searching, so it has to answer
 * three things without ambiguity: is this corpus readable by this build, how
 * far behind its sources is it, and what is actually in it.
 *
 * Compatibility is reported as a field rather than thrown as an error, because
 * "your corpus is unreadable and here is why" is exactly the situation `status`
 * exists to describe.
 */

import { checkIdentity, SCHEMA_VERSION } from "../../domain/model/corpus-identity.ts";
import { assessFreshness, type Freshness, type RevisionComparison } from "../../domain/model/freshness.ts";
import { chunkingFingerprint } from "../../domain/service/chunker.ts";
import type { CorpusConfig } from "../config.ts";
import { CORPUS_META_KEYS } from "../corpus-meta.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { Warning } from "../dto/mappers.ts";
import type { CorpusStore } from "../ports/repositories.ts";
import type { SourceReader } from "../ports/sources.ts";
import type { Hasher } from "../ports/system.ts";

export interface DescribeDependencies {
  readonly store: CorpusStore;
  readonly config: CorpusConfig;
  readonly hasher: Hasher;
  readonly path: string;
  readonly scope: string;
  /** Live sources, used to compare current revisions against indexed ones. */
  readonly sources?: readonly SourceReader[];
}

export interface SourceSummary {
  readonly id: string;
  readonly kind: string;
  readonly uri: string;
  readonly revision: string | null;
  readonly documentCount: number;
}

export interface DescribeOutcome {
  readonly name: string;
  readonly path: string;
  readonly scope: string;
  readonly corpusSchemaVersion: string;
  readonly embedding: Record<string, unknown>;
  readonly chunking: Record<string, unknown>;
  readonly counts: Record<string, number>;
  readonly freshness: Freshness;
  readonly sources: SourceSummary[];
  readonly compatible: boolean;
  readonly incompatibility: string | null;
  readonly warnings: Warning[];
}

/** Compare what a corpus was built with against what the caller is configured for. */
export function corpusFreshness(dependencies: DescribeDependencies): Freshness {
  const { store } = dependencies;
  const liveRevisions = new Map<string, string | null>();
  for (const source of dependencies.sources ?? []) {
    liveRevisions.set(source.spec.id, source.revision());
  }

  const comparisons: RevisionComparison[] = store.meta.listSources().map((record) => ({
    sourceId: record.id,
    indexedRevision: record.revision,
    // With no live source to ask, the indexed revision is all we know; treating
    // it as current avoids reporting false staleness for an unreadable source.
    currentRevision: liveRevisions.get(record.id) ?? record.revision,
  }));

  return assessFreshness(store.meta.get(CORPUS_META_KEYS.builtAt), comparisons);
}

export function describeCorpus(dependencies: DescribeDependencies): DescribeOutcome {
  const { store, config, hasher } = dependencies;
  const warnings: Warning[] = [];

  const embeddingId = store.meta.get(CORPUS_META_KEYS.embeddingId);
  const storedFingerprint = store.meta.get(CORPUS_META_KEYS.chunkingFingerprint);
  const semantic = store.meta.get(CORPUS_META_KEYS.embeddingSemantic) === "1";
  const expectedFingerprint = chunkingFingerprint((input) => hasher.hashText(input), config.chunking);

  const built = store.meta.get(CORPUS_META_KEYS.builtAt) !== null;
  // An unbuilt corpus has no identities to check; only a built one can be
  // incompatible, and reporting one as such would be misleading noise.
  const incompatibility = built
    ? checkIdentity(
        {
          schemaVersion: store.meta.get(CORPUS_META_KEYS.schemaVersion) ?? SCHEMA_VERSION,
          embeddingId: embeddingId ?? undefined,
          chunkingFingerprint: storedFingerprint ?? undefined,
          chunkingSchemaVersion: store.meta.get(CORPUS_META_KEYS.chunkingSchemaVersion) ?? "",
        },
        { chunkingFingerprint: expectedFingerprint },
      )
    : null;

  const freshness = corpusFreshness(dependencies);
  if (freshness.status === "stale") {
    warnings.push({
      code: WarningCode.STALE_CORPUS,
      message: freshness.reason ?? "corpus is behind its sources",
      details: { built_at: freshness.builtAt },
    });
  }

  const failures = store.meta.listFailures();
  if (failures.length > 0) {
    warnings.push({
      code: WarningCode.PARTIAL_INDEX,
      message: `${failures.length} file(s) failed to index`,
      details: { refs: failures.slice(0, 10).map((failure) => failure.ref) },
    });
  }

  if (built && !semantic) {
    warnings.push({
      code: WarningCode.LEXICAL_EMBEDDING,
      message:
        "this corpus uses the built-in lexical embedder; configure a semantic embedding " +
        "model and rebuild for paraphrase recall",
      details: { embedding_id: embeddingId },
    });
  }

  const documentsBySource = store.documents.countBySource();

  return {
    name: store.meta.get(CORPUS_META_KEYS.corpusName) ?? config.name,
    path: dependencies.path,
    scope: dependencies.scope,
    corpusSchemaVersion: store.meta.get(CORPUS_META_KEYS.schemaVersion) ?? SCHEMA_VERSION,
    embedding: {
      id: embeddingId,
      provider: config.embedding.provider,
      model: config.embedding.model,
      dimensions: Number(store.meta.get(CORPUS_META_KEYS.embeddingDimensions) ?? 0),
      semantic,
    },
    chunking: {
      fingerprint: storedFingerprint,
      expected_fingerprint: expectedFingerprint,
      ...store.meta.getJson<Record<string, unknown>>(CORPUS_META_KEYS.chunkingConfig, {}),
    },
    counts: {
      documents: store.documents.count(),
      chunks: store.chunks.count(),
      vectors: store.vectors.size(),
      nodes: store.graph.nodeCount(),
      edges: store.graph.edgeCount(),
      failures: failures.length,
      exclusions: store.meta.listExclusions().length,
    },
    freshness,
    sources: store.meta.listSources().map((record) => ({
      id: record.id,
      kind: record.kind,
      uri: record.uri,
      revision: record.revision,
      documentCount: documentsBySource.get(record.id) ?? 0,
    })),
    compatible: incompatibility === null,
    incompatibility: incompatibility?.message ?? null,
    warnings,
  };
}
