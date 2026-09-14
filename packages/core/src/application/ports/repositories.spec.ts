import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryStore } from "../../__fixtures__/in-memory-store.ts";
import type { CorpusStore } from "./repositories.ts";

/**
 * The port defines a contract two adapters must satisfy: the SQLite store and
 * the in-memory test double. This pins the invariants both owe callers; the
 * SQLite adapter's own spec then verifies it against a real database.
 */
describe("application/ports/repositories", () => {
  function fresh(): CorpusStore {
    return new InMemoryStore();
  }

  it("exposes every repository behind one handle", () => {
    const store = fresh();
    for (const key of ["documents", "chunks", "vectors", "lexical", "graph", "meta"] as const) {
      assert.ok(store[key] !== undefined, `missing ${key}`);
    }
  });

  it("starts empty", () => {
    const store = fresh();
    assert.equal(store.documents.count(), 0);
    assert.equal(store.chunks.count(), 0);
    assert.equal(store.vectors.size(), 0);
    assert.equal(store.graph.edgeCount(), 0);
  });

  it("runs work inside a transaction and returns its value", () => {
    const store = fresh();
    assert.equal(store.transaction(() => 42), 42);
  });

  it("propagates a failure out of a transaction", () => {
    const store = fresh();
    assert.throws(() =>
      store.transaction(() => {
        throw new Error("boom");
      }),
    );
  });

  it("removes derived rows along with a document", () => {
    const store = new InMemoryStore();
    store.addDocument({ ref: "docs/a.md", text: "content here" });
    assert.ok(store.chunks.count() > 0);

    store.documents.remove(["docs/a.md"]);
    assert.equal(store.documents.count(), 0);
    assert.equal(store.chunks.count(), 0, "chunks must not outlive their document");
  });

  it("reports file state for incremental diffing", () => {
    const store = new InMemoryStore();
    store.addDocument({ ref: "docs/a.md", text: "content" });
    assert.equal(store.documents.fileState().size, 1);
  });

  it("returns an empty map when asked for chunks that do not exist", () => {
    assert.equal(fresh().chunks.getMany(["nope"]).size, 0);
  });

  it("closes without throwing", () => {
    assert.doesNotThrow(() => fresh().close());
  });
});
