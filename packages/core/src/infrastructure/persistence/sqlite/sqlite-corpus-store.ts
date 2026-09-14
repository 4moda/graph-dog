/**
 * The SQLite implementation of every persistence port.
 *
 * Layout decisions worth stating:
 *
 * - **Vectors are float32 blobs, not a separate vector database.** For the
 *   corpus sizes GraphDog targets, an exhaustive scan is milliseconds, and it
 *   is exactly reproducible and adds nothing to the portable artifact.
 *   `VectorIndex` is the seam where an ANN backend would attach if that ceases
 *   to hold.
 * - **Postings are a table.** BM25 therefore scores the whole corpus on every
 *   query rather than re-ranking whatever the vector search happened to find,
 *   which is what makes the two signals genuinely independent.
 * - **Parameters are chunked into batches.** SQLite has a host-parameter limit
 *   (999 by default on older builds), so every `IN (...)` is batched.
 */

import type { Chunk } from "../../../domain/model/chunk.ts";
import type { SourceDocument } from "../../../domain/model/document.ts";
import type { GraphEdge, GraphNode, EdgeKind, NodeKind } from "../../../domain/model/graph.ts";
import { documentNodeId } from "../../../domain/model/graph.ts";
import { createLocation } from "../../../domain/model/location.ts";
import type { CorpusStatistics, Posting } from "../../../domain/service/bm25.ts";
import { termFrequencies } from "../../../domain/service/tokenizer.ts";
import { CORPUS_META_KEYS } from "../../../application/corpus-meta.ts";
import type {
  BuildFailureRecord,
  ChunkRepository,
  CorpusMetaRepository,
  CorpusStore,
  DocumentRepository,
  ExclusionRecord,
  GraphRepository,
  LexicalIndex,
  SourceRecord,
  VectorIndex,
} from "../../../application/ports/repositories.ts";
import { SCHEMA_VERSION, CHUNKING_SCHEMA_VERSION } from "../../../domain/model/corpus-identity.ts";
import type { Database, Row, SqlValue } from "./database.ts";
import { openDatabase } from "./database.ts";
import { SCHEMA_SQL } from "./schema.ts";
import { compareStrings } from "../../../domain/ordering.ts";

/** Conservative batch size for `IN (...)` clauses, well under SQLite's limit. */
const PARAM_BATCH = 400;

// Column accessors accept `undefined` because `noUncheckedIndexedAccess` makes
// every row lookup optional. Coercing here keeps that noise out of every query.
type Cell = SqlValue | undefined;

function str(value: Cell): string {
  return value === null || value === undefined ? "" : String(value);
}

function num(value: Cell): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function nullableStr(value: Cell): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseJson<T>(value: Cell, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/** Split an id list into batches small enough for one prepared statement. */
function* batches<T>(items: readonly T[], size = PARAM_BATCH): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += size) {
    yield items.slice(offset, offset + size);
  }
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

export class SqliteCorpusStore implements CorpusStore {
  readonly #db: Database;
  #vectorCache: { ids: string[]; matrix: Float32Array[]; dimensions: number } | null = null;
  #statisticsCache: CorpusStatistics | null = null;

  private constructor(db: Database) {
    this.#db = db;
  }

  static async open(path: string): Promise<SqliteCorpusStore> {
    const db = await openDatabase(path);
    db.exec(SCHEMA_SQL);
    const store = new SqliteCorpusStore(db);
    if (store.meta.get(CORPUS_META_KEYS.schemaVersion) === null) {
      store.meta.set(CORPUS_META_KEYS.schemaVersion, SCHEMA_VERSION);
      store.meta.set(CORPUS_META_KEYS.chunkingSchemaVersion, CHUNKING_SCHEMA_VERSION);
    }
    return store;
  }

  /**
   * Run `work` inside one transaction.
   *
   * A build must be all-or-nothing across documents, vectors, postings and the
   * graph; a crash halfway through has to leave the previous corpus intact
   * rather than a half-updated one that still answers queries.
   */
  transaction<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  /** Reclaim space after large deletions. Optional; never on the hot path. */
  compact(): void {
    this.#db.exec("VACUUM");
  }

  // --- documents -----------------------------------------------------------

  readonly documents: DocumentRepository = {
    fileState: (): Map<string, string> => {
      const rows = this.#db.prepare("SELECT ref, content_hash FROM documents").all();
      return new Map(rows.map((row) => [str(row["ref"]), str(row["content_hash"])]));
    },

    get: (ref: string): SourceDocument | null => {
      const row = this.#db.prepare("SELECT * FROM documents WHERE ref = ?").get(ref);
      return row === undefined ? null : toDocument(row);
    },

    listRefs: (): string[] =>
      this.#db
        .prepare("SELECT ref FROM documents ORDER BY ref")
        .all()
        .map((row) => str(row["ref"])),

    upsert: (document: SourceDocument): void => {
      this.#db
        .prepare(
          `INSERT INTO documents (ref, source_id, title, media_type, content_hash, size, mtime,
             revision, indexed_at, total_lines, text, page_breaks, tags, links)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(ref) DO UPDATE SET
             source_id=excluded.source_id, title=excluded.title, media_type=excluded.media_type,
             content_hash=excluded.content_hash, size=excluded.size, mtime=excluded.mtime,
             revision=excluded.revision, indexed_at=excluded.indexed_at,
             total_lines=excluded.total_lines, text=excluded.text,
             page_breaks=excluded.page_breaks, tags=excluded.tags, links=excluded.links`,
        )
        .run(
          document.ref,
          document.sourceId,
          document.title,
          document.mediaType,
          document.contentHash,
          document.size,
          document.mtime,
          document.revision,
          document.indexedAt,
          document.totalLines,
          document.text,
          JSON.stringify(document.pageBreaks),
          JSON.stringify(document.tags),
          JSON.stringify(document.links),
        );
    },

    remove: (refs: readonly string[]): void => {
      if (refs.length === 0) return;
      for (const batch of batches(refs)) {
        const marks = placeholders(batch.length);
        // Order matters: derived rows first, so nothing is left orphaned even
        // if this is interrupted outside a transaction.
        this.#db
          .prepare(
            `DELETE FROM postings WHERE chunk_id IN
               (SELECT chunk_id FROM chunks WHERE ref IN (${marks}))`,
          )
          .run(...batch);
        this.#db
          .prepare(
            `DELETE FROM vectors WHERE chunk_id IN
               (SELECT chunk_id FROM chunks WHERE ref IN (${marks}))`,
          )
          .run(...batch);
        this.#db.prepare(`DELETE FROM chunks WHERE ref IN (${marks})`).run(...batch);
        this.#db.prepare(`DELETE FROM documents WHERE ref IN (${marks})`).run(...batch);
      }
      this.#vectorCache = null;
      this.#statisticsCache = null;
    },

    count: (): number => num(this.#db.prepare("SELECT COUNT(*) AS n FROM documents").get()?.["n"]),

    countBySource: (): Map<string, number> => {
      const rows = this.#db
        .prepare("SELECT source_id, COUNT(*) AS n FROM documents GROUP BY source_id")
        .all();
      return new Map(rows.map((row) => [str(row["source_id"]), num(row["n"])]));
    },
  };

  // --- chunks --------------------------------------------------------------

  readonly chunks: ChunkRepository = {
    insert: (chunk: Chunk): void => {
      this.#db
        .prepare(
          `INSERT OR REPLACE INTO chunks (chunk_id, ref, ordinal, text, start_char, end_char,
             start_line, end_line, page, heading_path, token_count)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          chunk.chunkId,
          chunk.ref,
          chunk.ordinal,
          chunk.text,
          chunk.location.startChar,
          chunk.location.endChar,
          chunk.location.startLine,
          chunk.location.endLine,
          chunk.location.page,
          chunk.headingPath,
          chunk.tokenCount,
        );
      this.#statisticsCache = null;
    },

    get: (chunkId: string): Chunk | null => {
      const row = this.#db.prepare("SELECT * FROM chunks WHERE chunk_id = ?").get(chunkId);
      return row === undefined ? null : toChunk(row);
    },

    getMany: (chunkIds: readonly string[]): Map<string, Chunk> => {
      const out = new Map<string, Chunk>();
      for (const batch of batches(chunkIds)) {
        const rows = this.#db
          .prepare(`SELECT * FROM chunks WHERE chunk_id IN (${placeholders(batch.length)})`)
          .all(...batch);
        for (const row of rows) out.set(str(row["chunk_id"]), toChunk(row));
      }
      return out;
    },

    listByRef: (ref: string): Chunk[] =>
      this.#db
        .prepare("SELECT * FROM chunks WHERE ref = ? ORDER BY ordinal")
        .all(ref)
        .map(toChunk),

    listAllIds: (): string[] =>
      this.#db
        .prepare("SELECT chunk_id FROM chunks ORDER BY chunk_id")
        .all()
        .map((row) => str(row["chunk_id"])),

    ownerMap: (): Map<string, string> =>
      new Map(
        this.#db
          .prepare("SELECT chunk_id, ref FROM chunks")
          .all()
          .map((row) => [str(row["chunk_id"]), str(row["ref"])] as const),
      ),

    count: (): number => num(this.#db.prepare("SELECT COUNT(*) AS n FROM chunks").get()?.["n"]),
  };

  // --- vectors -------------------------------------------------------------

  readonly vectors: VectorIndex = {
    put: (chunkId: string, vector: Float32Array): void => {
      this.#db
        .prepare("INSERT OR REPLACE INTO vectors (chunk_id, vec) VALUES (?, ?)")
        .run(chunkId, new Uint8Array(vector.buffer.slice(0), vector.byteOffset, vector.byteLength));
      this.#vectorCache = null;
    },

    search: (query: Float32Array, topK: number): Array<[string, number]> => {
      const cache = this.#loadVectors();
      if (cache.ids.length === 0 || topK <= 0) return [];
      // A dimension mismatch means the corpus was built with a different model.
      // The compatibility gate should have caught it; returning nothing rather
      // than scoring garbage is the safe second line of defence.
      if (cache.dimensions !== query.length) return [];

      const scored: Array<[string, number]> = [];
      for (let i = 0; i < cache.ids.length; i += 1) {
        const vector = cache.matrix[i];
        const id = cache.ids[i];
        if (vector === undefined || id === undefined) continue;
        let dot = 0;
        for (let j = 0; j < vector.length; j += 1) dot += (vector[j] ?? 0) * (query[j] ?? 0);
        scored.push([id, dot]);
      }
      scored.sort((a, b) => (b[1] === a[1] ? compareStrings(a[0], b[0]) : b[1] - a[1]));
      return scored.slice(0, topK);
    },

    neighbors: (chunkIds: readonly string[], topK: number): Map<string, Array<[string, number]>> => {
      const cache = this.#loadVectors();
      const position = new Map(cache.ids.map((id, index) => [id, index] as const));
      const out = new Map<string, Array<[string, number]>>();
      for (const chunkId of chunkIds) {
        const index = position.get(chunkId);
        if (index === undefined) continue;
        const vector = cache.matrix[index];
        if (vector === undefined) continue;
        out.set(
          chunkId,
          this.vectors.search(vector, topK + 1).filter(([id]) => id !== chunkId).slice(0, topK),
        );
      }
      return out;
    },

    size: (): number => num(this.#db.prepare("SELECT COUNT(*) AS n FROM vectors").get()?.["n"]),

    invalidate: (): void => {
      this.#vectorCache = null;
    },
  };

  #loadVectors(): { ids: string[]; matrix: Float32Array[]; dimensions: number } {
    if (this.#vectorCache !== null) return this.#vectorCache;
    const rows = this.#db.prepare("SELECT chunk_id, vec FROM vectors ORDER BY chunk_id").all();
    const ids: string[] = [];
    const matrix: Float32Array[] = [];
    let dimensions = 0;
    for (const row of rows) {
      const blob = row["vec"];
      if (!(blob instanceof Uint8Array)) continue;
      // Copy rather than view: the driver's buffer is not guaranteed to be
      // aligned for Float32Array, and an unaligned view throws.
      const copy = new Uint8Array(blob);
      const vector = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
      ids.push(str(row["chunk_id"]));
      matrix.push(vector);
      dimensions = vector.length;
    }
    this.#vectorCache = { ids, matrix, dimensions };
    return this.#vectorCache;
  }

  // --- lexical -------------------------------------------------------------

  readonly lexical: LexicalIndex = {
    indexChunk: (chunkId: string, text: string): number => {
      const counts = termFrequencies(text);
      const statement = this.#db.prepare(
        "INSERT OR REPLACE INTO postings (term, chunk_id, tf) VALUES (?, ?, ?)",
      );
      let total = 0;
      for (const [term, tf] of counts) {
        statement.run(term, chunkId, tf);
        total += tf;
      }
      this.#statisticsCache = null;
      return total;
    },

    rebuildStatistics: (): void => {
      // Recomputed wholesale rather than maintained incrementally: an update
      // that deleted documents would otherwise leave inflated document
      // frequencies that quietly skew every subsequent query.
      this.#db.exec("DELETE FROM terms");
      this.#db.exec(
        "INSERT INTO terms (term, df) SELECT term, COUNT(*) FROM postings GROUP BY term",
      );
      const row = this.#db
        .prepare("SELECT COUNT(*) AS n, COALESCE(AVG(token_count), 0.0) AS avg FROM chunks")
        .get();
      this.meta.set(CORPUS_META_KEYS.bm25ChunkCount, String(num(row?.["n"])));
      this.meta.set(CORPUS_META_KEYS.bm25AverageLength, String(num(row?.["avg"])));
      this.#statisticsCache = null;
    },

    statistics: (): CorpusStatistics => {
      if (this.#statisticsCache !== null) return this.#statisticsCache;
      this.#statisticsCache = {
        chunkCount: Number(this.meta.get(CORPUS_META_KEYS.bm25ChunkCount) ?? "0"),
        averageTokenCount: Number(this.meta.get(CORPUS_META_KEYS.bm25AverageLength) ?? "0"),
      };
      return this.#statisticsCache;
    },

    postingsFor: (terms: readonly string[]): Posting[] => {
      const out: Posting[] = [];
      for (const batch of batches([...new Set(terms)])) {
        const rows = this.#db
          .prepare(
            `SELECT p.term AS term, p.chunk_id AS chunk_id, p.tf AS tf,
                    t.df AS df, c.token_count AS token_count
             FROM postings p
             JOIN terms  t ON t.term = p.term
             JOIN chunks c ON c.chunk_id = p.chunk_id
             WHERE p.term IN (${placeholders(batch.length)})`,
          )
          .all(...batch);
        for (const row of rows) {
          out.push({
            term: str(row["term"]),
            chunkId: str(row["chunk_id"]),
            tf: num(row["tf"]),
            df: num(row["df"]),
            tokenCount: num(row["token_count"]),
          });
        }
      }
      return out;
    },
  };

  // --- graph ---------------------------------------------------------------

  readonly graph: GraphRepository = {
    replaceAll: (nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void => {
      this.#db.exec("DELETE FROM edges");
      this.#db.exec("DELETE FROM nodes");
      const insertNode = this.#db.prepare(
        "INSERT OR REPLACE INTO nodes (node_id, kind, label, ref) VALUES (?,?,?,?)",
      );
      for (const node of nodes) insertNode.run(node.id, node.kind, node.label, node.ref);
      const insertEdge = this.#db.prepare(
        "INSERT OR REPLACE INTO edges (src, dst, kind, weight) VALUES (?,?,?,?)",
      );
      for (const edge of edges) insertEdge.run(edge.src, edge.dst, edge.kind, edge.weight);
    },

    outgoing: (nodeIds: readonly string[]): GraphEdge[] => {
      const out: GraphEdge[] = [];
      for (const batch of batches(nodeIds)) {
        const rows = this.#db
          .prepare(
            `SELECT src, dst, kind, weight FROM edges
             WHERE src IN (${placeholders(batch.length)})
             ORDER BY src, dst, kind`,
          )
          .all(...batch);
        for (const row of rows) out.push(toEdge(row));
      }
      return out;
    },

    neighborhood: (refs: readonly string[], limit: number) => {
      if (refs.length === 0) return { nodes: [], edges: [] };
      const nodeIds = refs.map(documentNodeId);
      const marks = placeholders(nodeIds.length);
      const edgeRows = this.#db
        .prepare(
          `SELECT src, dst, kind, weight FROM edges
           WHERE src IN (${marks}) OR dst IN (${marks})
           ORDER BY src, dst, kind LIMIT ?`,
        )
        .all(...nodeIds, ...nodeIds, limit);
      const edges = edgeRows.map(toEdge);

      const touched = new Set<string>(nodeIds);
      for (const edge of edges) {
        touched.add(edge.src);
        touched.add(edge.dst);
      }
      const nodes: GraphNode[] = [];
      for (const batch of batches([...touched].sort())) {
        const rows = this.#db
          .prepare(
            `SELECT node_id, kind, label, ref FROM nodes
             WHERE node_id IN (${placeholders(batch.length)}) ORDER BY node_id`,
          )
          .all(...batch);
        for (const row of rows) {
          nodes.push({
            id: str(row["node_id"]),
            kind: str(row["kind"]) as NodeKind,
            label: str(row["label"]),
            ref: nullableStr(row["ref"]),
          });
        }
      }
      return { nodes, edges };
    },

    nodeCount: (): number => num(this.#db.prepare("SELECT COUNT(*) AS n FROM nodes").get()?.["n"]),
    edgeCount: (): number => num(this.#db.prepare("SELECT COUNT(*) AS n FROM edges").get()?.["n"]),
  };

  // --- meta ----------------------------------------------------------------

  readonly meta: CorpusMetaRepository = {
    get: (key: string): string | null => {
      const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
      return row === undefined ? null : str(row["value"]);
    },

    set: (key: string, value: string): void => {
      this.#db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
    },

    getJson: <T>(key: string, fallback: T): T => {
      const raw = this.meta.get(key);
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },

    setJson: (key: string, value: unknown): void => {
      this.meta.set(key, JSON.stringify(value));
    },

    listSources: (): SourceRecord[] =>
      this.#db
        .prepare("SELECT * FROM sources ORDER BY id")
        .all()
        .map((row) => ({
          id: str(row["id"]),
          kind: str(row["kind"]),
          uri: str(row["uri"]),
          revision: nullableStr(row["revision"]),
          indexedAt: nullableStr(row["indexed_at"]),
          spec: parseJson<Record<string, unknown>>(row["spec"], {}),
        })),

    upsertSource: (record: SourceRecord): void => {
      this.#db
        .prepare(
          `INSERT INTO sources (id, kind, uri, spec, revision, indexed_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, uri=excluded.uri,
             spec=excluded.spec, revision=excluded.revision, indexed_at=excluded.indexed_at`,
        )
        .run(
          record.id,
          record.kind,
          record.uri,
          JSON.stringify(record.spec),
          record.revision,
          record.indexedAt,
        );
    },

    removeSource: (sourceId: string): void => {
      const refs = this.#db
        .prepare("SELECT ref FROM documents WHERE source_id = ?")
        .all(sourceId)
        .map((row) => str(row["ref"]));
      this.documents.remove(refs);
      this.#db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
    },

    recordFailure: (failure: BuildFailureRecord): void => {
      this.#db
        .prepare(
          "INSERT OR REPLACE INTO failures (ref, stage, code, message, at) VALUES (?,?,?,?,?)",
        )
        .run(failure.ref, failure.stage, failure.code, failure.message, failure.at);
    },

    clearFailures: (refs: readonly string[]): void => {
      if (refs.length === 0) return;
      for (const batch of batches(refs)) {
        this.#db
          .prepare(`DELETE FROM failures WHERE ref IN (${placeholders(batch.length)})`)
          .run(...batch);
      }
    },

    listFailures: (): BuildFailureRecord[] =>
      this.#db
        .prepare("SELECT * FROM failures ORDER BY ref, stage")
        .all()
        .map((row) => ({
          ref: str(row["ref"]),
          stage: str(row["stage"]),
          code: str(row["code"]),
          message: str(row["message"]),
          at: str(row["at"]),
        })),

    replaceExclusions: (records: readonly ExclusionRecord[]): void => {
      this.#db.exec("DELETE FROM exclusions");
      const statement = this.#db.prepare(
        "INSERT OR REPLACE INTO exclusions (ref, reason, details) VALUES (?,?,?)",
      );
      for (const record of records) {
        statement.run(record.ref, record.reason, JSON.stringify(record.details));
      }
    },

    listExclusions: (): ExclusionRecord[] =>
      this.#db
        .prepare("SELECT * FROM exclusions ORDER BY ref, reason")
        .all()
        .map((row) => ({
          ref: str(row["ref"]),
          reason: str(row["reason"]),
          details: parseJson<Record<string, unknown>>(row["details"], {}),
        })),
  };
}

function toDocument(row: Row): SourceDocument {
  return {
    ref: str(row["ref"]),
    sourceId: str(row["source_id"]),
    title: str(row["title"]),
    mediaType: str(row["media_type"]),
    contentHash: str(row["content_hash"]),
    size: num(row["size"]),
    mtime: num(row["mtime"]),
    revision: nullableStr(row["revision"]),
    indexedAt: str(row["indexed_at"]),
    totalLines: num(row["total_lines"]),
    text: str(row["text"]),
    pageBreaks: parseJson<Array<[number, number]>>(row["page_breaks"], []),
    tags: parseJson<string[]>(row["tags"], []),
    links: parseJson<string[]>(row["links"], []),
  };
}

function toChunk(row: Row): Chunk {
  return {
    chunkId: str(row["chunk_id"]),
    ref: str(row["ref"]),
    ordinal: num(row["ordinal"]),
    text: str(row["text"]),
    location: createLocation({
      startLine: num(row["start_line"]),
      endLine: num(row["end_line"]),
      startChar: num(row["start_char"]),
      endChar: num(row["end_char"]),
      page: row["page"] === null ? null : num(row["page"]),
    }),
    headingPath: str(row["heading_path"]),
    tokenCount: num(row["token_count"]),
  };
}

function toEdge(row: Row): GraphEdge {
  return {
    src: str(row["src"]),
    dst: str(row["dst"]),
    kind: str(row["kind"]) as EdgeKind,
    weight: num(row["weight"]),
  };
}
