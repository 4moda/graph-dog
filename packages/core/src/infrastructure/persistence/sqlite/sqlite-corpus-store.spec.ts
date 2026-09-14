import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { SourceDocument } from "../../../domain/model/document.ts";
import { documentNodeId, tagNodeId } from "../../../domain/model/graph.ts";
import { createLocation } from "../../../domain/model/location.ts";
import { SqliteCorpusStore } from "./sqlite-corpus-store.ts";
import { CORPUS_FILENAME } from "./schema.ts";

let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "graphdog-sqlite-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

let counter = 0;
async function freshStore(): Promise<SqliteCorpusStore> {
  counter += 1;
  return SqliteCorpusStore.open(join(directory, `${counter}-${CORPUS_FILENAME}`));
}

function document(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    ref: "docs/a.md",
    sourceId: "docs",
    title: "Doc A",
    mediaType: "text/markdown",
    contentHash: "hash-1",
    size: 42,
    mtime: 1_700_000_000,
    revision: "abc123",
    indexedAt: "2026-09-14T00:00:00.000Z",
    totalLines: 3,
    text: "line one\nline two\nline three",
    pageBreaks: [],
    tags: ["auth"],
    links: ["b.md"],
    ...overrides,
  };
}

function chunk(chunkId: string, ref: string, text: string, tokenCount = 3) {
  return {
    chunkId,
    ref,
    ordinal: 0,
    text,
    location: createLocation({ startLine: 1, endLine: 2, startChar: 0, endChar: text.length }),
    headingPath: "Section",
    tokenCount,
  };
}

describe("infrastructure/persistence/sqlite/sqliteCorpusStore", () => {
  it("creates a usable corpus file and stamps its schema version", async () => {
    const store = await freshStore();
    assert.equal(store.meta.get("schema_version"), "1");
    assert.equal(store.documents.count(), 0);
    store.close();
  });

  describe("documents", () => {
    it("round-trips every field, including JSON columns", async () => {
      const store = await freshStore();
      const original = document({ pageBreaks: [[0, 1] as const, [100, 2] as const] });
      store.documents.upsert(original);

      const loaded = store.documents.get("docs/a.md");
      assert.deepEqual(loaded, original);
      store.close();
    });

    it("preserves full text with no truncation", async () => {
      const store = await freshStore();
      const long = "x".repeat(200_000);
      store.documents.upsert(document({ text: long }));
      assert.equal(store.documents.get("docs/a.md")?.text.length, 200_000);
      store.close();
    });

    it("preserves non-ASCII text exactly", async () => {
      const store = await freshStore();
      const japanese = "アクセストークンの設計方針\n認証基盤について";
      store.documents.upsert(document({ text: japanese }));
      assert.equal(store.documents.get("docs/a.md")?.text, japanese);
      store.close();
    });

    it("updates in place on a second upsert", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      store.documents.upsert(document({ title: "Renamed", contentHash: "hash-2" }));
      assert.equal(store.documents.count(), 1);
      assert.equal(store.documents.get("docs/a.md")?.title, "Renamed");
      store.close();
    });

    it("returns null for an unknown ref", async () => {
      const store = await freshStore();
      assert.equal(store.documents.get("docs/missing.md"), null);
      store.close();
    });

    it("reports file state for incremental diffing", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      assert.deepEqual([...store.documents.fileState()], [["docs/a.md", "hash-1"]]);
      store.close();
    });

    it("counts documents per source", async () => {
      const store = await freshStore();
      store.documents.upsert(document({ ref: "docs/a.md", sourceId: "docs" }));
      store.documents.upsert(document({ ref: "spec/b.md", sourceId: "spec" }));
      assert.deepEqual(
        [...store.documents.countBySource()].sort(),
        [
          ["docs", 1],
          ["spec", 1],
        ],
      );
      store.close();
    });

    it("cascades removal to chunks, vectors and postings", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      const tokens = store.lexical.indexChunk("c1", "distinctive words here");
      store.chunks.insert(chunk("c1", "docs/a.md", "distinctive words here", tokens));
      store.vectors.put("c1", Float32Array.from([1, 0, 0]));
      store.lexical.rebuildStatistics();

      store.documents.remove(["docs/a.md"]);

      assert.equal(store.documents.count(), 0);
      assert.equal(store.chunks.count(), 0);
      assert.equal(store.vectors.size(), 0);
      assert.equal(store.lexical.postingsFor(["distinctive"]).length, 0);
      store.close();
    });

    it("removes a large batch without exceeding SQLite's parameter limit", async () => {
      const store = await freshStore();
      const refs: string[] = [];
      for (let i = 0; i < 1200; i += 1) {
        const ref = `docs/f${i}.md`;
        refs.push(ref);
        store.documents.upsert(document({ ref }));
      }
      store.documents.remove(refs);
      assert.equal(store.documents.count(), 0);
      store.close();
    });
  });

  describe("chunks", () => {
    it("round-trips a chunk with its location", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      const original = chunk("c1", "docs/a.md", "body text");
      store.chunks.insert(original);
      assert.deepEqual(store.chunks.get("c1"), original);
      store.close();
    });

    it("preserves a null page for unpaginated sources", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      store.chunks.insert(chunk("c1", "docs/a.md", "body"));
      assert.equal(store.chunks.get("c1")?.location.page, null);
      store.close();
    });

    it("preserves a page number for paginated sources", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      const paged = chunk("c1", "docs/a.md", "body");
      store.chunks.insert({
        ...paged,
        location: createLocation({ ...paged.location, page: 4 }),
      });
      assert.equal(store.chunks.get("c1")?.location.page, 4);
      store.close();
    });

    it("fetches many chunks in one call", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      store.chunks.insert(chunk("c1", "docs/a.md", "one"));
      store.chunks.insert(chunk("c2", "docs/a.md", "two"));
      assert.equal(store.chunks.getMany(["c1", "c2", "missing"]).size, 2);
      store.close();
    });

    it("maps chunks back to their owning document", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      store.chunks.insert(chunk("c1", "docs/a.md", "one"));
      assert.equal(store.chunks.ownerMap().get("c1"), "docs/a.md");
      store.close();
    });
  });

  describe("vectors", () => {
    it("round-trips float32 values", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      store.chunks.insert(chunk("c1", "docs/a.md", "body"));
      store.vectors.put("c1", Float32Array.from([0.5, -0.25, 0.125]));
      const [hit] = store.vectors.search(Float32Array.from([1, 0, 0]), 1);
      assert.equal(hit?.[0], "c1");
      assert.ok(Math.abs((hit?.[1] ?? 0) - 0.5) < 1e-6);
      store.close();
    });

    it("ranks by cosine similarity, best first", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      store.chunks.insert(chunk("near", "docs/a.md", "a"));
      store.chunks.insert(chunk("far", "docs/a.md", "b"));
      store.vectors.put("near", Float32Array.from([1, 0, 0]));
      store.vectors.put("far", Float32Array.from([0, 1, 0]));
      assert.deepEqual(
        store.vectors.search(Float32Array.from([1, 0, 0]), 2).map(([id]) => id),
        ["near", "far"],
      );
      store.close();
    });

    it("returns nothing rather than garbage on a dimension mismatch", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      store.chunks.insert(chunk("c1", "docs/a.md", "body"));
      store.vectors.put("c1", Float32Array.from([1, 0, 0]));
      assert.deepEqual(store.vectors.search(Float32Array.from([1, 0, 0, 0]), 5), []);
      store.close();
    });

    it("finds nearest neighbours excluding the query chunk itself", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      for (const [id, vector] of [
        ["c1", [1, 0, 0]],
        ["c2", [0.9, 0.1, 0]],
        ["c3", [0, 0, 1]],
      ] as const) {
        store.chunks.insert(chunk(id, "docs/a.md", id));
        store.vectors.put(id, Float32Array.from(vector));
      }
      const neighbors = store.vectors.neighbors(["c1"], 1);
      assert.deepEqual(neighbors.get("c1")?.map(([id]) => id), ["c2"]);
      store.close();
    });

    it("breaks score ties deterministically", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      for (const id of ["zeta", "alpha"]) {
        store.chunks.insert(chunk(id, "docs/a.md", id));
        store.vectors.put(id, Float32Array.from([1, 0, 0]));
      }
      assert.deepEqual(
        store.vectors.search(Float32Array.from([1, 0, 0]), 2).map(([id]) => id),
        ["alpha", "zeta"],
      );
      store.close();
    });
  });

  describe("lexical index", () => {
    it("scores over the whole corpus, not a shortlist", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      const tokens = store.lexical.indexChunk("c1", "jwks endpoint publishes keys");
      store.chunks.insert(chunk("c1", "docs/a.md", "jwks endpoint publishes keys", tokens));
      store.lexical.rebuildStatistics();

      const postings = store.lexical.postingsFor(["jwks"]);
      assert.equal(postings.length, 1);
      assert.equal(postings[0]?.chunkId, "c1");
      assert.equal(postings[0]?.df, 1);
      store.close();
    });

    it("recomputes statistics so deletions do not skew document frequency", async () => {
      const store = await freshStore();
      store.documents.upsert(document({ ref: "docs/a.md" }));
      store.documents.upsert(document({ ref: "docs/b.md" }));
      for (const [id, ref] of [
        ["c1", "docs/a.md"],
        ["c2", "docs/b.md"],
      ] as const) {
        const tokens = store.lexical.indexChunk(id, "shared term");
        store.chunks.insert(chunk(id, ref, "shared term", tokens));
      }
      store.lexical.rebuildStatistics();
      assert.equal(store.lexical.postingsFor(["shared"])[0]?.df, 2);

      store.documents.remove(["docs/b.md"]);
      store.lexical.rebuildStatistics();
      assert.equal(store.lexical.postingsFor(["shared"])[0]?.df, 1, "df must follow deletions");
      store.close();
    });

    it("reports corpus statistics used by BM25 length normalization", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      const tokens = store.lexical.indexChunk("c1", "one two three four");
      store.chunks.insert(chunk("c1", "docs/a.md", "one two three four", tokens));
      store.lexical.rebuildStatistics();

      const statistics = store.lexical.statistics();
      assert.equal(statistics.chunkCount, 1);
      assert.equal(statistics.averageTokenCount, 4);
      store.close();
    });

    it("indexes Japanese bigrams", async () => {
      const store = await freshStore();
      store.documents.upsert(document());
      const tokens = store.lexical.indexChunk("c1", "アクセストークン");
      store.chunks.insert(chunk("c1", "docs/a.md", "アクセストークン", tokens));
      store.lexical.rebuildStatistics();
      assert.ok(store.lexical.postingsFor(["トー"]).length > 0);
      store.close();
    });
  });

  describe("graph", () => {
    it("replaces the whole graph, leaving no orphan edges", async () => {
      const store = await freshStore();
      store.graph.replaceAll(
        [{ id: documentNodeId("docs/a.md"), kind: "document", label: "A", ref: "docs/a.md" }],
        [{ src: documentNodeId("docs/a.md"), dst: tagNodeId("t"), kind: "same_tag", weight: 0.5 }],
      );
      assert.equal(store.graph.edgeCount(), 1);

      store.graph.replaceAll([], []);
      assert.equal(store.graph.edgeCount(), 0);
      assert.equal(store.graph.nodeCount(), 0);
      store.close();
    });

    it("returns outgoing edges for expansion", async () => {
      const store = await freshStore();
      store.graph.replaceAll(
        [],
        [
          { src: documentNodeId("a"), dst: documentNodeId("b"), kind: "links_to", weight: 1 },
          { src: documentNodeId("c"), dst: documentNodeId("d"), kind: "links_to", weight: 1 },
        ],
      );
      const edges = store.graph.outgoing([documentNodeId("a")]);
      assert.equal(edges.length, 1);
      assert.equal(edges[0]?.dst, documentNodeId("b"));
      store.close();
    });

    it("returns a neighbourhood including inbound edges", async () => {
      const store = await freshStore();
      store.graph.replaceAll(
        [
          { id: documentNodeId("a"), kind: "document", label: "A", ref: "a" },
          { id: documentNodeId("b"), kind: "document", label: "B", ref: "b" },
        ],
        [{ src: documentNodeId("a"), dst: documentNodeId("b"), kind: "links_to", weight: 1 }],
      );
      const { nodes, edges } = store.graph.neighborhood(["b"], 10);
      assert.equal(edges.length, 1, "an inbound edge must be included");
      assert.equal(nodes.length, 2);
      store.close();
    });

    it("returns an empty neighbourhood for no refs", async () => {
      const store = await freshStore();
      assert.deepEqual(store.graph.neighborhood([], 10), { nodes: [], edges: [] });
      store.close();
    });
  });

  describe("meta, failures and exclusions", () => {
    it("round-trips string and JSON metadata", async () => {
      const store = await freshStore();
      store.meta.set("k", "v");
      store.meta.setJson("j", { a: 1 });
      assert.equal(store.meta.get("k"), "v");
      assert.deepEqual(store.meta.getJson("j", {}), { a: 1 });
      assert.deepEqual(store.meta.getJson("absent", { fallback: true }), { fallback: true });
      store.close();
    });

    it("records and clears build failures", async () => {
      const store = await freshStore();
      store.meta.recordFailure({
        ref: "docs/bad.pdf",
        stage: "extract",
        code: "extraction_failed",
        message: "no text layer",
        at: "2026-09-14T00:00:00.000Z",
      });
      assert.equal(store.meta.listFailures().length, 1);
      store.meta.clearFailures(["docs/bad.pdf"]);
      assert.equal(store.meta.listFailures().length, 0);
      store.close();
    });

    it("records exclusions with their reason, for audit", async () => {
      const store = await freshStore();
      store.meta.replaceExclusions([
        { ref: "docs/.env", reason: "secret_pattern", details: { path: ".env" } },
      ]);
      const [exclusion] = store.meta.listExclusions();
      assert.equal(exclusion?.reason, "secret_pattern");
      assert.deepEqual(exclusion?.details, { path: ".env" });
      store.close();
    });

    it("removes a source and every document under it", async () => {
      const store = await freshStore();
      store.meta.upsertSource({
        id: "docs",
        kind: "local",
        uri: "/docs",
        revision: null,
        indexedAt: null,
        spec: { id: "docs" },
      });
      store.documents.upsert(document());
      store.meta.removeSource("docs");
      assert.equal(store.meta.listSources().length, 0);
      assert.equal(store.documents.count(), 0);
      store.close();
    });
  });

  describe("transactions", () => {
    it("commits on success", async () => {
      const store = await freshStore();
      store.transaction(() => {
        store.documents.upsert(document());
      });
      assert.equal(store.documents.count(), 1);
      store.close();
    });

    it("rolls everything back on failure, leaving the corpus untouched", async () => {
      const store = await freshStore();
      store.documents.upsert(document({ ref: "docs/keep.md" }));

      assert.throws(() =>
        store.transaction(() => {
          store.documents.upsert(document({ ref: "docs/discard.md" }));
          throw new Error("build interrupted");
        }),
      );

      assert.equal(store.documents.get("docs/discard.md"), null, "partial write survived");
      assert.ok(store.documents.get("docs/keep.md"), "prior state must be intact");
      store.close();
    });
  });

  describe("persistence", () => {
    it("survives close and reopen", async () => {
      counter += 1;
      const path = join(directory, `reopen-${counter}-${CORPUS_FILENAME}`);

      const first = await SqliteCorpusStore.open(path);
      first.documents.upsert(document());
      const tokens = first.lexical.indexChunk("c1", "persisted content");
      first.chunks.insert(chunk("c1", "docs/a.md", "persisted content", tokens));
      first.vectors.put("c1", Float32Array.from([1, 0, 0]));
      first.lexical.rebuildStatistics();
      first.close();

      const second = await SqliteCorpusStore.open(path);
      assert.equal(second.documents.count(), 1);
      assert.equal(second.chunks.count(), 1);
      assert.equal(second.vectors.size(), 1);
      assert.equal(second.lexical.postingsFor(["persisted"]).length, 1);
      second.close();
    });
  });
});
