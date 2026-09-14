import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { openDatabase } from "./database.ts";
import { CORPUS_FILENAME, SCHEMA_SQL } from "./schema.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-schema-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const EXPECTED_TABLES = [
  "chunks",
  "documents",
  "edges",
  "exclusions",
  "failures",
  "meta",
  "nodes",
  "postings",
  "sources",
  "terms",
  "vectors",
];

describe("infrastructure/persistence/sqlite/schema", () => {
  it("names the corpus file", () => {
    assert.equal(CORPUS_FILENAME, "corpus.sqlite3");
  });

  it("creates every table the store needs", async () => {
    const database = await openDatabase(join(root, "a.sqlite3"));
    database.exec(SCHEMA_SQL);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => String(row["name"]));
    assert.deepEqual(tables, EXPECTED_TABLES);
    database.close();
  });

  it("is idempotent, so opening an existing corpus is safe", async () => {
    const database = await openDatabase(join(root, "b.sqlite3"));
    database.exec(SCHEMA_SQL);
    assert.doesNotThrow(() => database.exec(SCHEMA_SQL));
    database.close();
  });

  it("indexes the columns every query filters on", async () => {
    const database = await openDatabase(join(root, "c.sqlite3"));
    database.exec(SCHEMA_SQL);
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((row) => String(row["name"]));
    for (const expected of ["idx_chunks_ref", "idx_postings_chunk", "idx_edges_src", "idx_edges_dst"]) {
      assert.ok(indexes.includes(expected), `missing ${expected}`);
    }
    database.close();
  });

  it("uses STRICT tables, so a type error fails loudly instead of coercing", async () => {
    const database = await openDatabase(join(root, "d.sqlite3"));
    database.exec(SCHEMA_SQL);
    assert.throws(() =>
      database
        .prepare("INSERT INTO chunks (chunk_id, ref, ordinal, text, start_char, end_char, start_line, end_line, heading_path, token_count) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run("c1", "docs/a.md", "not-a-number", "body", 0, 1, 1, 1, "", 0),
    );
    database.close();
  });
});
