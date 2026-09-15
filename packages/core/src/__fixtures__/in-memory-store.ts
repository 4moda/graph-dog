/**
 * An in-memory `CorpusStore` for unit tests.
 *
 * Its existence is the payoff of the ports boundary: the query pipeline can be
 * tested against exact, hand-authored scores with no SQLite file, no
 * filesystem, and no embedding model. The SQLite adapter is then verified
 * separately against the same interface.
 *
 * Excluded from the published build.
 */

import type { Chunk } from "../domain/model/chunk.ts";
import type { SourceDocument } from "../domain/model/document.ts";
import type { GraphEdge, GraphNode } from "../domain/model/graph.ts";
import { countLines, createLocation } from "../domain/model/location.ts";
import type { CorpusStatistics, Posting } from "../domain/service/bm25.ts";
import { termFrequencies } from "../domain/service/tokenizer.ts";
import type {
  BuildFailureRecord,
  CorpusStore,
  ExclusionRecord,
  SourceRecord,
} from "../application/ports/repositories.ts";
import type { EmbeddingModel } from "../application/ports/models.ts";
import { compareStrings } from "../domain/ordering.ts";

export class InMemoryStore implements CorpusStore {
  readonly #documents = new Map<string, SourceDocument>();
  readonly #chunks = new Map<string, Chunk>();
  readonly #vectors = new Map<string, Float32Array>();
  readonly #postings = new Map<string, Map<string, number>>(); // term -> chunkId -> tf
  readonly #nodes = new Map<string, GraphNode>();
  #edges: GraphEdge[] = [];
  readonly #meta = new Map<string, string>();
  readonly #sources = new Map<string, SourceRecord>();
  #failures: BuildFailureRecord[] = [];
  #exclusions: ExclusionRecord[] = [];
  closed = false;

  readonly documents = {
    fileState: (): Map<string, string> =>
      new Map([...this.#documents.values()].map((d) => [d.ref, d.contentHash])),
    get: (ref: string): SourceDocument | null => this.#documents.get(ref) ?? null,
    listRefs: (): string[] => [...this.#documents.keys()].sort(),
    upsert: (document: SourceDocument): void => {
      this.#documents.set(document.ref, document);
    },
    remove: (refs: readonly string[]): void => {
      for (const ref of refs) {
        this.#documents.delete(ref);
        for (const [chunkId, chunk] of this.#chunks) {
          if (chunk.ref !== ref) continue;
          this.#chunks.delete(chunkId);
          this.#vectors.delete(chunkId);
          for (const postings of this.#postings.values()) postings.delete(chunkId);
        }
      }
    },
    count: (): number => this.#documents.size,
    countBySource: (): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const document of this.#documents.values()) {
        counts.set(document.sourceId, (counts.get(document.sourceId) ?? 0) + 1);
      }
      return counts;
    },
  };

  readonly chunks = {
    insert: (chunk: Chunk): void => {
      this.#chunks.set(chunk.chunkId, chunk);
    },
    get: (chunkId: string): Chunk | null => this.#chunks.get(chunkId) ?? null,
    getMany: (chunkIds: readonly string[]): Map<string, Chunk> => {
      const out = new Map<string, Chunk>();
      for (const id of chunkIds) {
        const chunk = this.#chunks.get(id);
        if (chunk) out.set(id, chunk);
      }
      return out;
    },
    listByRef: (ref: string): Chunk[] =>
      [...this.#chunks.values()]
        .filter((chunk) => chunk.ref === ref)
        .sort((a, b) => a.ordinal - b.ordinal),
    listAllIds: (): string[] => [...this.#chunks.keys()].sort(),
    ownerMap: (): Map<string, string> =>
      new Map([...this.#chunks.values()].map((chunk) => [chunk.chunkId, chunk.ref])),
    count: (): number => this.#chunks.size,
  };

  readonly vectors = {
    put: (chunkId: string, vector: Float32Array): void => {
      this.#vectors.set(chunkId, vector);
    },
    search: (query: Float32Array, topK: number): Array<[string, number]> => {
      const scored: Array<[string, number]> = [];
      for (const [chunkId, vector] of this.#vectors) {
        if (vector.length !== query.length) continue;
        let dot = 0;
        for (let i = 0; i < vector.length; i += 1) dot += (vector[i] ?? 0) * (query[i] ?? 0);
        scored.push([chunkId, dot]);
      }
      scored.sort((a, b) => (b[1] === a[1] ? compareStrings(a[0], b[0]) : b[1] - a[1]));
      return scored.slice(0, topK);
    },
    neighbors: (chunkIds: readonly string[], topK: number): Map<string, Array<[string, number]>> => {
      const out = new Map<string, Array<[string, number]>>();
      for (const chunkId of chunkIds) {
        const vector = this.#vectors.get(chunkId);
        if (!vector) continue;
        out.set(
          chunkId,
          this.vectors.search(vector, topK + 1).filter(([id]) => id !== chunkId).slice(0, topK),
        );
      }
      return out;
    },
    size: (): number => this.#vectors.size,
    invalidate: (): void => undefined,
  };

  readonly lexical = {
    indexChunk: (chunkId: string, text: string): number => {
      let total = 0;
      for (const [term, tf] of termFrequencies(text)) {
        let bucket = this.#postings.get(term);
        if (!bucket) {
          bucket = new Map();
          this.#postings.set(term, bucket);
        }
        bucket.set(chunkId, tf);
        total += tf;
      }
      return total;
    },
    rebuildStatistics: (): void => undefined,
    statistics: (): CorpusStatistics => {
      const chunks = [...this.#chunks.values()];
      const total = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
      return {
        chunkCount: chunks.length,
        averageTokenCount: chunks.length === 0 ? 0 : total / chunks.length,
      };
    },
    postingsFor: (terms: readonly string[]): Posting[] => {
      const out: Posting[] = [];
      for (const term of terms) {
        const bucket = this.#postings.get(term);
        if (!bucket) continue;
        for (const [chunkId, tf] of bucket) {
          out.push({
            term,
            chunkId,
            tf,
            df: bucket.size,
            tokenCount: this.#chunks.get(chunkId)?.tokenCount ?? 1,
          });
        }
      }
      return out;
    },
  };

  readonly graph = {
    replaceAll: (nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void => {
      this.#nodes.clear();
      for (const node of nodes) this.#nodes.set(node.id, node);
      this.#edges = [...edges];
    },
    outgoing: (nodeIds: readonly string[]): GraphEdge[] => {
      const wanted = new Set(nodeIds);
      return this.#edges.filter((edge) => wanted.has(edge.src));
    },
    neighborhood: (
      refs: readonly string[],
      limit: number,
    ): { nodes: GraphNode[]; edges: GraphEdge[] } => {
      const wanted = new Set(refs.map((ref) => `doc:${ref}`));
      const edges = this.#edges
        .filter((edge) => wanted.has(edge.src) || wanted.has(edge.dst))
        .slice(0, limit);
      const touched = new Set([...wanted, ...edges.flatMap((e) => [e.src, e.dst])]);
      const nodes = [...this.#nodes.values()].filter((node) => touched.has(node.id));
      return { nodes, edges };
    },
    nodeCount: (): number => this.#nodes.size,
    edgeCount: (): number => this.#edges.length,
  };

  readonly meta = {
    get: (key: string): string | null => this.#meta.get(key) ?? null,
    set: (key: string, value: string): void => {
      this.#meta.set(key, value);
    },
    getJson: <T>(key: string, fallback: T): T => {
      const raw = this.#meta.get(key);
      if (raw === undefined) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    setJson: (key: string, value: unknown): void => {
      this.#meta.set(key, JSON.stringify(value));
    },
    listSources: (): SourceRecord[] =>
      [...this.#sources.values()].sort((a, b) => compareStrings(a.id, b.id)),
    upsertSource: (record: SourceRecord): void => {
      this.#sources.set(record.id, record);
    },
    removeSource: (sourceId: string): void => {
      this.#sources.delete(sourceId);
    },
    recordFailure: (failure: BuildFailureRecord): void => {
      this.#failures = [...this.#failures.filter((f) => f.ref !== failure.ref), failure];
    },
    clearFailures: (refs: readonly string[]): void => {
      const drop = new Set(refs);
      this.#failures = this.#failures.filter((failure) => !drop.has(failure.ref));
    },
    listFailures: (): BuildFailureRecord[] => [...this.#failures],
    replaceExclusions: (records: readonly ExclusionRecord[]): void => {
      this.#exclusions = [...records];
    },
    listExclusions: (): ExclusionRecord[] => [...this.#exclusions],
  };

  transaction<T>(work: () => T): T {
    return work();
  }

  close(): void {
    this.closed = true;
  }

  // -- test helpers ---------------------------------------------------------

  /** Add a document with one chunk per paragraph, indexing it lexically. */
  addDocument(input: {
    ref: string;
    text: string;
    title?: string;
    tags?: string[];
    links?: string[];
    revision?: string | null;
    vectorsByChunk?: Record<string, number[]>;
    /** Put every chunk on this page, as if the document were a PDF. */
    page?: number;
  }): Chunk[] {
    const [sourceId = "src"] = input.ref.split("/");
    this.documents.upsert({
      ref: input.ref,
      sourceId,
      title: input.title ?? input.ref,
      mediaType: "text/markdown",
      contentHash: `hash-${input.ref}`,
      size: input.text.length,
      mtime: 0,
      revision: input.revision ?? null,
      indexedAt: "2026-09-14T00:00:00.000Z",
      totalLines: countLines(input.text),
      text: input.text,
      pageBreaks: [],
      tags: input.tags ?? [],
      links: input.links ?? [],
    });

    const created: Chunk[] = [];
    input.text.split("\n\n").forEach((body, ordinal) => {
      if (body.trim() === "") return;
      const chunkId = `${input.ref}#${ordinal}`;
      const tokenCount = this.lexical.indexChunk(chunkId, body);
      const chunk: Chunk = {
        chunkId,
        ref: input.ref,
        ordinal,
        text: body,
        location: createLocation({
          startLine: ordinal + 1,
          endLine: ordinal + 1,
          startChar: 0,
          endChar: body.length,
          ...(input.page === undefined ? {} : { page: input.page }),
        }),
        headingPath: "",
        tokenCount,
      };
      this.chunks.insert(chunk);
      const vector = input.vectorsByChunk?.[chunkId];
      if (vector) this.vectors.put(chunkId, Float32Array.from(vector));
      created.push(chunk);
    });
    return created;
  }
}

/** A deterministic stand-in for an embedding model, with no model to download. */
export class StubEmbeddingModel implements EmbeddingModel {
  readonly id = "stub:v1:d3";
  readonly dimensions = 3;
  readonly semantic: boolean;
  readonly minUsefulSimilarity = 0.15;
  readonly #vectors: Map<string, number[]>;

  constructor(vectors: Record<string, number[]> = {}, semantic = true) {
    this.#vectors = new Map(Object.entries(vectors));
    this.semantic = semantic;
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => Float32Array.from(this.#vectors.get(text) ?? [0, 0, 0]));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return Float32Array.from(this.#vectors.get(text) ?? [0, 0, 0]);
  }
}
