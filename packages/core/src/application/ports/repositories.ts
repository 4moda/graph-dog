/**
 * Persistence ports.
 *
 * The application layer talks to these interfaces and never to SQLite. That
 * boundary is what lets the query pipeline be unit-tested against in-memory
 * fakes, and it is where an alternative backend would attach.
 *
 * Everything is synchronous. The reference implementation is `node:sqlite`,
 * which is synchronous by design, and making the ports async to hedge against
 * a hypothetical remote backend would infect every use case with promises for
 * no present benefit.
 */

import type { Chunk } from "../../domain/model/chunk.ts";
import type { SourceDocument } from "../../domain/model/document.ts";
import type { GraphEdge, GraphNode } from "../../domain/model/graph.ts";
import type { CorpusStatistics, Posting } from "../../domain/service/bm25.ts";

export interface BuildFailureRecord {
  readonly ref: string;
  readonly stage: string;
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface ExclusionRecord {
  readonly ref: string;
  readonly reason: string;
  readonly details: Record<string, unknown>;
}

export interface SourceRecord {
  readonly id: string;
  readonly kind: string;
  readonly uri: string;
  readonly revision: string | null;
  readonly indexedAt: string | null;
  readonly spec: Record<string, unknown>;
}

export interface DocumentRepository {
  /** `ref` to content hash, for incremental diffing. */
  fileState(): Map<string, string>;
  get(ref: string): SourceDocument | null;
  listRefs(): string[];
  upsert(document: SourceDocument): void;
  /** Remove documents and every derived row: chunks, vectors, postings. */
  remove(refs: readonly string[]): void;
  count(): number;
  countBySource(): Map<string, number>;
}

export interface ChunkRepository {
  insert(chunk: Chunk): void;
  get(chunkId: string): Chunk | null;
  getMany(chunkIds: readonly string[]): Map<string, Chunk>;
  listByRef(ref: string): Chunk[];
  listAllIds(): string[];
  /** `chunkId` to the ref that owns it, for collapsing chunk hits to documents. */
  ownerMap(): Map<string, string>;
  count(): number;
}

export interface VectorIndex {
  put(chunkId: string, vector: Float32Array): void;
  /** Top-k by cosine similarity. Vectors are stored normalized, so this is a dot product. */
  search(query: Float32Array, topK: number): Array<[string, number]>;
  /** Nearest other chunks for each id, used when building similarity edges. */
  neighbors(chunkIds: readonly string[], topK: number): Map<string, Array<[string, number]>>;
  size(): number;
  /** Drop any cached view after a write. */
  invalidate(): void;
}

export interface LexicalIndex {
  /** Write postings for one chunk and return its token count. */
  indexChunk(chunkId: string, text: string): number;
  /** Recompute document frequencies and mean length. Run once after a build. */
  rebuildStatistics(): void;
  statistics(): CorpusStatistics;
  /** Postings for the given terms, across the whole corpus. */
  postingsFor(terms: readonly string[]): Posting[];
}

export interface GraphRepository {
  replaceAll(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void;
  outgoing(nodeIds: readonly string[]): GraphEdge[];
  /** Nodes and edges touching the given documents, for `explore` output. */
  neighborhood(refs: readonly string[], limit: number): { nodes: GraphNode[]; edges: GraphEdge[] };
  nodeCount(): number;
  edgeCount(): number;
}

export interface CorpusMetaRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
  getJson<T>(key: string, fallback: T): T;
  setJson(key: string, value: unknown): void;

  listSources(): SourceRecord[];
  upsertSource(record: SourceRecord): void;
  removeSource(sourceId: string): void;

  recordFailure(failure: BuildFailureRecord): void;
  clearFailures(refs: readonly string[]): void;
  listFailures(): BuildFailureRecord[];

  replaceExclusions(records: readonly ExclusionRecord[]): void;
  listExclusions(): ExclusionRecord[];
}

/**
 * Everything a corpus exposes, wired together.
 *
 * `transaction` is the reason this is one object rather than five injected
 * separately: a build must be all-or-nothing across documents, vectors,
 * postings and the graph. The predecessor spread these over four files that
 * could not be updated atomically, so an interrupted build left them
 * disagreeing with each other.
 */
export interface CorpusStore {
  readonly documents: DocumentRepository;
  readonly chunks: ChunkRepository;
  readonly vectors: VectorIndex;
  readonly lexical: LexicalIndex;
  readonly graph: GraphRepository;
  readonly meta: CorpusMetaRepository;
  transaction<T>(work: () => T): T;
  close(): void;
}
