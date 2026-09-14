import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { openDatabase } from "./database.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-db-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
function path(): string {
  counter += 1;
  return join(root, `db-${counter}.sqlite3`);
}

describe("infrastructure/persistence/sqlite/database", () => {
  it("opens a database and runs statements", async () => {
    const database = await openDatabase(path());
    database.exec("CREATE TABLE t (a TEXT)");
    database.prepare("INSERT INTO t (a) VALUES (?)").run("x");
    const rows = database.prepare("SELECT a FROM t").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["a"], "x");
    database.close();
  });

  it("returns rows whose fields are readable by key", async () => {
    // `node:sqlite` rows are null-prototype objects, so `deepEqual` against an
    // object literal fails and anything relying on Object.prototype methods
    // breaks. The store therefore reads every column through an accessor, and
    // this pins the property the adapter actually depends on.
    const database = await openDatabase(path());
    database.exec("CREATE TABLE t (a TEXT, b INTEGER)");
    database.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run("x", 7);
    const row = database.prepare("SELECT a, b FROM t").get();
    assert.equal(row?.["a"], "x");
    assert.equal(row?.["b"], 7);
    database.close();
  });

  it("enables WAL, so a search is never blocked by a build", async () => {
    const database = await openDatabase(path());
    const mode = database.prepare("PRAGMA journal_mode").get();
    assert.equal(String(mode?.["journal_mode"]).toLowerCase(), "wal");
    database.close();
  });

  it("enforces foreign keys", async () => {
    const database = await openDatabase(path());
    assert.equal(Number(database.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]), 1);
    database.close();
  });

  it("returns undefined for a query with no rows", async () => {
    const database = await openDatabase(path());
    database.exec("CREATE TABLE t (a TEXT)");
    assert.equal(database.prepare("SELECT a FROM t").get(), undefined);
    database.close();
  });

  it("round-trips a binary blob unchanged", async () => {
    const database = await openDatabase(path());
    database.exec("CREATE TABLE b (v BLOB)");
    const bytes = new Uint8Array([0, 1, 2, 255, 128]);
    database.prepare("INSERT INTO b (v) VALUES (?)").run(bytes);
    const stored = database.prepare("SELECT v FROM b").get()?.["v"];
    assert.ok(stored instanceof Uint8Array);
    assert.deepEqual([...(stored as Uint8Array)], [...bytes]);
    database.close();
  });

  it("round-trips non-ASCII text", async () => {
    const database = await openDatabase(path());
    database.exec("CREATE TABLE t (a TEXT)");
    database.prepare("INSERT INTO t (a) VALUES (?)").run("アクセストークン");
    assert.equal(database.prepare("SELECT a FROM t").get()?.["a"], "アクセストークン");
    database.close();
  });

  it("persists across reopening the same file", async () => {
    const file = path();
    const first = await openDatabase(file);
    first.exec("CREATE TABLE t (a TEXT)");
    first.prepare("INSERT INTO t (a) VALUES (?)").run("kept");
    first.close();

    const second = await openDatabase(file);
    assert.equal(second.prepare("SELECT a FROM t").get()?.["a"], "kept");
    second.close();
  });
});
