import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ArchiveError } from "../../../domain/errors.ts";
import { documentNodeId } from "../../../domain/model/graph.ts";
import { CORPUS_META_KEYS } from "../../../application/corpus-meta.ts";
import { openDatabase } from "./database.ts";
import { SqliteCorpusFileInspector } from "./corpus-file-inspector.ts";
import { SqliteCorpusStore } from "./sqlite-corpus-store.ts";

let directory: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "graphdog-inspector-"));
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

let counter = 0;
function fresh(name: string): string {
  counter += 1;
  return join(directory, `${counter}-${name}`);
}

const inspector = new SqliteCorpusFileInspector();

/** A small real corpus, returned as snapshot bytes -- exactly what an export ships. */
async function corpusBytes(): Promise<Uint8Array> {
  const store = await SqliteCorpusStore.open(fresh("corpus.sqlite3"));
  try {
    store.meta.set(CORPUS_META_KEYS.builtAt, "2026-09-14T00:00:00.000Z");
    store.meta.set(CORPUS_META_KEYS.embeddingId, "hash-v1:d256");
    store.meta.set(CORPUS_META_KEYS.chunkingFingerprint, "chunk1:0123456789abcdef");
    store.meta.upsertSource({
      id: "spec",
      kind: "git",
      uri: "../spec",
      revision: "a1b2c3d4",
      indexedAt: "2026-09-14T00:00:00.000Z",
      spec: {},
    });
    store.meta.upsertSource({
      id: "docs",
      kind: "local",
      uri: "./docs",
      revision: null,
      indexedAt: "2026-09-14T00:00:00.000Z",
      spec: {},
    });
    store.documents.upsert({
      ref: "docs/keys.md",
      sourceId: "docs",
      title: "Key Management",
      mediaType: "text/markdown",
      contentHash: "hash-keys",
      size: 40,
      mtime: 0,
      revision: null,
      indexedAt: "2026-09-14T00:00:00.000Z",
      totalLines: 1,
      text: "Public keys are published at the JWKS endpoint.",
      pageBreaks: [],
      tags: [],
      links: [],
    });
    store.graph.replaceAll(
      [
        { id: documentNodeId("docs/keys.md"), kind: "document", label: "Keys", ref: "docs/keys.md" },
        { id: documentNodeId("docs/token.md"), kind: "document", label: "Token", ref: "docs/token.md" },
      ],
      [{ src: documentNodeId("docs/keys.md"), dst: documentNodeId("docs/token.md"), kind: "links_to", weight: 1 }],
    );
    store.meta.recordFailure({
      ref: "docs/scan.pdf",
      stage: "extract",
      code: "extraction_failed",
      message: "PDF support requires pdfjs-dist",
      at: "2026-09-14T00:00:00.000Z",
    });
    const out = fresh("snapshot.sqlite3");
    store.snapshotTo(out);
    return new Uint8Array(await readFile(out));
  } finally {
    store.close();
  }
}

/** Run raw SQL against a copy of `bytes`, and return the changed bytes. */
async function altered(bytes: Uint8Array, sql: string): Promise<Uint8Array> {
  const path = fresh("altered.sqlite3");
  await writeFile(path, bytes);
  const database = await openDatabase(path);
  database.exec(sql);
  // Back to a rollback journal, so the bytes are a complete database on their own.
  database.exec("PRAGMA journal_mode = DELETE");
  database.close();
  return new Uint8Array(await readFile(path));
}

async function refuses(bytes: Uint8Array, pattern: RegExp): Promise<void> {
  await assert.rejects(
    () => inspector.inspect(bytes),
    (error: unknown) => {
      assert.ok(error instanceof ArchiveError, `expected ArchiveError, got ${String(error)}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe("infrastructure/persistence/sqlite/corpus-file-inspector", () => {
  it("reports the identity a corpus records about itself", async () => {
    const inspection = await inspector.inspect(await corpusBytes());
    assert.deepEqual(inspection.identity, {
      schemaVersion: "1",
      chunkingSchemaVersion: "1",
      embeddingId: "hash-v1:d256",
      chunkingFingerprint: "chunk1:0123456789abcdef",
    });
    assert.equal(inspection.builtAt, "2026-09-14T00:00:00.000Z");
  });

  it("counts what the corpus holds", async () => {
    const inspection = await inspector.inspect(await corpusBytes());
    assert.deepEqual(inspection.counts, { documents: 1, chunks: 0, nodes: 2, edges: 1 });
    assert.equal(inspection.failures, 1);
  });

  it("lists sources with their revisions, in a stable order", async () => {
    const inspection = await inspector.inspect(await corpusBytes());
    assert.deepEqual(inspection.sources, [
      { id: "docs", revision: null },
      { id: "spec", revision: "a1b2c3d4" },
    ]);
  });

  it("finds no foreign objects in a corpus GraphDog built", async () => {
    assert.deepEqual((await inspector.inspect(await corpusBytes())).foreignObjects, []);
  });

  it("lists triggers and views, which GraphDog never creates", async () => {
    const hostile = await altered(
      await corpusBytes(),
      "CREATE TRIGGER touch AFTER INSERT ON meta BEGIN UPDATE meta SET value = 'x' WHERE key = 'built_at'; END;" +
        "CREATE VIEW everything AS SELECT * FROM documents;",
    );
    assert.deepEqual((await inspector.inspect(hostile)).foreignObjects, ["trigger:touch", "view:everything"]);
  });

  it("reports a missing identity field as null rather than inventing one", async () => {
    const stripped = await altered(await corpusBytes(), "DELETE FROM meta WHERE key = 'embedding_id';");
    assert.equal((await inspector.inspect(stripped)).identity.embeddingId, null);
  });

  it("never modifies the bytes it was given", async () => {
    const bytes = await corpusBytes();
    const before = bytes.slice();
    await inspector.inspect(bytes);
    assert.deepEqual(bytes, before);
  });

  it("refuses bytes that are not SQLite at all", async () => {
    await refuses(new TextEncoder().encode("not a database ".repeat(100)), /not a readable GraphDog corpus/);
  });

  it("refuses an empty file, which SQLite would otherwise treat as an empty database", async () => {
    await refuses(new Uint8Array(0), /not a readable GraphDog corpus/);
  });

  it("refuses a SQLite database that is not a GraphDog corpus", async () => {
    const path = fresh("other.sqlite3");
    const database = await openDatabase(path);
    database.exec("CREATE TABLE unrelated (x INTEGER); PRAGMA journal_mode = DELETE;");
    database.close();
    await refuses(new Uint8Array(await readFile(path)), /not a readable GraphDog corpus/);
  });

  it("refuses a damaged database with SQLite's own diagnosis", async () => {
    const bytes = await corpusBytes();
    assert.ok(bytes.length > 8192, "the snapshot spans several pages");
    const damaged = bytes.slice();
    damaged.fill(0xa5, 4096 + 16, 8192);
    await refuses(damaged, /integrity check|malformed|not a readable GraphDog corpus/);
  });
});
