/**
 * Building and incrementally updating a corpus.
 *
 * Discover -> diff against what is indexed -> extract -> chunk -> embed ->
 * index -> rebuild the graph, all inside one transaction.
 *
 * Three commitments shape this:
 *
 * - **Partial success is reported as partial.** A file that cannot be read is
 *   recorded with its reason and the build continues; the report says `partial`
 *   and the process exits non-zero. A build that silently indexed 90% of a
 *   corpus is worse than one that says so.
 * - **Exclusions are auditable.** Every file skipped for being a secret, too
 *   large or empty is recorded with the reason, so "why is this not in my
 *   results" has an answer.
 * - **Atomicity.** Documents, chunks, vectors, postings and the graph are
 *   written in one transaction, so an interrupted build cannot leave them
 *   disagreeing with each other.
 */

import { computeChunkId } from "../../domain/model/chunk.ts";
import type { Chunk } from "../../domain/model/chunk.ts";
import { countLines } from "../../domain/model/location.ts";
import { ExtractionError, toGraphDogError } from "../../domain/errors.ts";
import { chunkText, chunkingFingerprint } from "../../domain/service/chunker.ts";
import { buildGraph, collapseChunkNeighbors } from "../../domain/service/graph-builder.ts";
import type { CorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { Warning } from "../dto/mappers.ts";
import type { BuildFailureRecord, CorpusStore, ExclusionRecord } from "../ports/repositories.ts";
import type { EmbeddingModel } from "../ports/models.ts";
import type { ExtractorRegistry, SourceReader } from "../ports/sources.ts";
import type { Clock, Hasher, Logger } from "../ports/system.ts";
import { SILENT_LOGGER } from "../ports/system.ts";
import { CORPUS_META_KEYS } from "../corpus-meta.ts";

export interface BuildOptions {
  /** Re-index every file, ignoring content hashes. */
  readonly full?: boolean;
  /** Restrict the build to these source ids. */
  readonly onlySources?: readonly string[];
}

export interface BuildDependencies {
  readonly store: CorpusStore;
  readonly config: CorpusConfig;
  readonly sources: readonly SourceReader[];
  readonly extractors: ExtractorRegistry;
  readonly embedding: EmbeddingModel;
  readonly clock: Clock;
  readonly hasher: Hasher;
  readonly readFile: (absolutePath: string) => Promise<Uint8Array>;
  readonly logger?: Logger;
}

export interface BuildOutcome {
  readonly corpus: string;
  readonly status: "ok" | "partial";
  readonly documents: { added: number; modified: number; deleted: number; unchanged: number };
  readonly chunks: number;
  readonly nodes: number;
  readonly edges: number;
  readonly failures: BuildFailureRecord[];
  readonly exclusions: ExclusionRecord[];
  readonly elapsedSeconds: number;
  readonly warnings: Warning[];
}

export async function buildCorpus(
  options: BuildOptions,
  dependencies: BuildDependencies,
): Promise<BuildOutcome> {
  const { store, config, extractors, embedding, clock, hasher } = dependencies;
  const logger = dependencies.logger ?? SILENT_LOGGER;
  const startedAt = clock.monotonicMs();
  const indexedAt = clock.nowIso();

  const warnings: Warning[] = [];
  const failures: BuildFailureRecord[] = [];
  const exclusions: ExclusionRecord[] = [];

  const activeSources = dependencies.sources.filter(
    (source) => !options.onlySources || options.onlySources.includes(source.spec.id),
  );

  // --- discovery ------------------------------------------------------------

  interface Candidate {
    readonly ref: string;
    readonly absolutePath: string;
    readonly size: number;
    readonly mtime: number;
    readonly sourceId: string;
    readonly revision: string | null;
  }

  const candidates: Candidate[] = [];
  const sourceRevisions = new Map<string, string | null>();

  for (const source of activeSources) {
    const revision = source.revision();
    sourceRevisions.set(source.spec.id, revision);
    for (const file of source.discover()) {
      candidates.push({ ...file, sourceId: source.spec.id, revision });
    }
    for (const exclusion of source.exclusions()) exclusions.push(exclusion);
  }

  // --- diff against what is already indexed ---------------------------------

  const indexed = store.documents.fileState();
  const scopedRefs = new Set(
    [...indexed.keys()].filter((ref) =>
      activeSources.some((source) => ref.startsWith(`${source.spec.id}/`)),
    ),
  );

  const toIndex: Candidate[] = [];
  let unchanged = 0;
  // Which refs are new versus changed. Counted after extraction rather than
  // here, so a file that fails to extract is reported as a failure and not
  // also as an indexed document -- otherwise the totals do not reconcile.
  const newRefs = new Set<string>();
  const changedRefs = new Set<string>();

  const contentHashes = new Map<string, string>();
  for (const candidate of candidates) {
    let hash: string;
    try {
      hash = hasher.hashBytes(await dependencies.readFile(candidate.absolutePath));
    } catch (error) {
      failures.push({
        ref: candidate.ref,
        stage: "read",
        code: "read_failed",
        message: toGraphDogError(error).message,
        at: indexedAt,
      });
      scopedRefs.delete(candidate.ref);
      continue;
    }
    contentHashes.set(candidate.ref, hash);
    scopedRefs.delete(candidate.ref);

    const previous = indexed.get(candidate.ref);
    if (!options.full && previous === hash) {
      unchanged += 1;
      continue;
    }
    if (previous === undefined) newRefs.add(candidate.ref);
    else changedRefs.add(candidate.ref);
    toIndex.push(candidate);
  }

  // Anything still in `scopedRefs` was indexed before and is gone now.
  const deletedRefs = [...scopedRefs].sort();

  logger.log("info", "build plan", {
    new: newRefs.size,
    changed: changedRefs.size,
    deleted: deletedRefs.length,
    unchanged,
  });

  // --- extract and chunk ----------------------------------------------------

  interface PreparedDocument {
    readonly candidate: Candidate;
    readonly title: string;
    readonly mediaType: string;
    readonly text: string;
    readonly tags: readonly string[];
    readonly links: readonly string[];
    readonly pageBreaks: ReadonlyArray<readonly [number, number]>;
    readonly chunks: Chunk[];
  }

  const prepared: PreparedDocument[] = [];
  const fingerprint = chunkingFingerprint((input) => hasher.hashText(input), config.chunking);

  for (const candidate of toIndex) {
    try {
      const extracted = await extractors.extract(candidate.absolutePath);
      for (const note of extracted.notes) {
        warnings.push({
          code: WarningCode.EXTRACTION_NOTE,
          message: `${candidate.ref}: ${note}`,
          details: { ref: candidate.ref },
        });
      }

      const drafts = chunkText(extracted.text, config.chunking, extracted.pageBreaks);
      const chunks: Chunk[] = drafts.map((draft) => ({
        chunkId: computeChunkId((input) => hasher.hashText(input), {
          ref: candidate.ref,
          ordinal: draft.ordinal,
          startChar: draft.location.startChar,
          endChar: draft.location.endChar,
          text: draft.text,
        }),
        ref: candidate.ref,
        ordinal: draft.ordinal,
        text: draft.text,
        location: draft.location,
        headingPath: draft.headingPath,
        tokenCount: 0, // filled in when the lexical index analyzes it
      }));

      prepared.push({
        candidate,
        title: extracted.title,
        mediaType: extracted.mediaType,
        text: extracted.text,
        tags: extracted.tags,
        links: extracted.links,
        pageBreaks: extracted.pageBreaks,
        chunks,
      });
    } catch (error) {
      const failure = error instanceof ExtractionError ? error : toGraphDogError(error);
      failures.push({
        ref: candidate.ref,
        stage: "extract",
        code: failure.code,
        message: failure.message,
        at: indexedAt,
      });
      logger.log("warn", "extraction failed", { ref: candidate.ref, error: failure.message });
    }
  }

  // --- embed ----------------------------------------------------------------
  //
  // Batched outside the transaction: embedding is the slow part and may hit a
  // model, and holding a write transaction open across it would block readers
  // for the whole build.

  const allChunks = prepared.flatMap((document) => document.chunks);
  const vectors = new Map<string, Float32Array>();
  if (allChunks.length > 0) {
    const batchSize = Math.max(1, config.embedding.batchSize);
    for (let offset = 0; offset < allChunks.length; offset += batchSize) {
      const batch = allChunks.slice(offset, offset + batchSize);
      const embedded = await embedding.embedDocuments(batch.map((chunk) => contextualize(chunk)));
      batch.forEach((chunk, index) => {
        const vector = embedded[index];
        if (vector) vectors.set(chunk.chunkId, vector);
      });
    }
  }

  // --- write ----------------------------------------------------------------

  const counts = store.transaction(() => {
    if (deletedRefs.length > 0) {
      store.documents.remove(deletedRefs);
      store.meta.clearFailures(deletedRefs);
    }
    // Re-indexed documents are removed first so their old chunks, vectors and
    // postings go with them; chunk ids change with content, so leaving them
    // would strand unreachable rows that still skew BM25 statistics.
    const reindexed = prepared.map((document) => document.candidate.ref);
    if (reindexed.length > 0) {
      store.documents.remove(reindexed);
      store.meta.clearFailures(reindexed);
    }

    for (const document of prepared) {
      store.documents.upsert({
        ref: document.candidate.ref,
        sourceId: document.candidate.sourceId,
        title: document.title,
        mediaType: document.mediaType,
        contentHash: contentHashes.get(document.candidate.ref) ?? "",
        size: document.candidate.size,
        mtime: document.candidate.mtime,
        revision: document.candidate.revision,
        indexedAt,
        totalLines: countLines(document.text),
        text: document.text,
        pageBreaks: document.pageBreaks,
        tags: document.tags,
        links: document.links,
      });

      for (const chunk of document.chunks) {
        const tokenCount = store.lexical.indexChunk(chunk.chunkId, chunk.text);
        store.chunks.insert({ ...chunk, tokenCount });
        const vector = vectors.get(chunk.chunkId);
        if (vector) store.vectors.put(chunk.chunkId, vector);
      }
    }

    for (const failure of failures) store.meta.recordFailure(failure);
    store.meta.replaceExclusions(exclusions);
    store.lexical.rebuildStatistics();
    store.vectors.invalidate();

    // --- graph ------------------------------------------------------------
    const documents = store.documents.listRefs().map((ref) => {
      const document = store.documents.get(ref);
      return {
        ref,
        title: document?.title ?? ref,
        tags: document?.tags ?? [],
        links: document?.links ?? [],
      };
    });

    const similarities = config.graph.enableSimilarity
      ? collapseChunkNeighbors(
          store.vectors.neighbors(store.chunks.listAllIds(), 5),
          store.chunks.ownerMap(),
        )
      : [];

    const graph = buildGraph(documents, similarities, config.graph);
    store.graph.replaceAll(graph.nodes, graph.edges);

    for (const source of activeSources) {
      store.meta.upsertSource({
        id: source.spec.id,
        kind: source.spec.kind,
        uri: source.spec.uri,
        revision: sourceRevisions.get(source.spec.id) ?? null,
        indexedAt,
        spec: { ...source.spec },
      });
    }

    store.meta.set(CORPUS_META_KEYS.builtAt, indexedAt);
    store.meta.set(CORPUS_META_KEYS.embeddingId, embedding.id);
    store.meta.set(CORPUS_META_KEYS.embeddingDimensions, String(embedding.dimensions));
    store.meta.set(CORPUS_META_KEYS.embeddingSemantic, embedding.semantic ? "1" : "0");
    store.meta.set(CORPUS_META_KEYS.chunkingFingerprint, fingerprint);
    store.meta.setJson(CORPUS_META_KEYS.chunkingConfig, config.chunking);
    store.meta.set(CORPUS_META_KEYS.corpusName, config.name);

    return {
      chunks: store.chunks.count(),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    };
  });

  // Only documents that survived extraction are reported as indexed.
  let added = 0;
  let modified = 0;
  for (const document of prepared) {
    if (newRefs.has(document.candidate.ref)) added += 1;
    else if (changedRefs.has(document.candidate.ref)) modified += 1;
  }

  const status: "ok" | "partial" = failures.length > 0 ? "partial" : "ok";
  if (status === "partial") {
    warnings.push({
      code: WarningCode.PARTIAL_INDEX,
      message: `${failures.length} file(s) could not be indexed; the corpus is incomplete`,
      details: { failures: failures.length },
    });
  }

  return {
    corpus: config.name,
    status,
    documents: { added, modified, deleted: deletedRefs.length, unchanged },
    chunks: counts.chunks,
    nodes: counts.nodes,
    edges: counts.edges,
    failures,
    exclusions,
    elapsedSeconds: (clock.monotonicMs() - startedAt) / 1000,
    warnings,
  };
}

/**
 * Prefix a chunk with its location before embedding.
 *
 * A bare chunk loses the context a human would use to judge it: which document
 * it came from and which section. Embedding that context with the text makes a
 * chunk from `designs/auth/token.md` retrievable by "auth design" even when the
 * body never uses those words.
 */
function contextualize(chunk: Chunk): string {
  const heading = chunk.headingPath === "" ? "" : ` :: ${chunk.headingPath}`;
  return `[${chunk.ref}${heading}]\n${chunk.text}`;
}
