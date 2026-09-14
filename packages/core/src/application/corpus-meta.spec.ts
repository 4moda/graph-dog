import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CORPUS_META_KEYS } from "./corpus-meta.ts";

describe("application/corpusMeta", () => {
  it("uses a distinct storage key for every fact", () => {
    const values = Object.values(CORPUS_META_KEYS);
    assert.equal(new Set(values).size, values.length, "a collision would silently overwrite state");
  });

  it("carries the three identities the compatibility gate compares", () => {
    assert.ok(CORPUS_META_KEYS.schemaVersion);
    assert.ok(CORPUS_META_KEYS.embeddingId);
    assert.ok(CORPUS_META_KEYS.chunkingFingerprint);
  });

  it("uses snake_case keys, matching what is written to the store", () => {
    for (const value of Object.values(CORPUS_META_KEYS)) {
      assert.match(value, /^[a-z][a-z0-9_]*$/, `${value} should be snake_case`);
    }
  });
});
