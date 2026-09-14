import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { computeChunkId } from "./chunk.ts";

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

const base = { ref: "docs/a.md", ordinal: 0, startChar: 0, endChar: 10, text: "hello there" };

describe("domain/model/chunk", () => {
  it("is deterministic for identical input", () => {
    assert.equal(computeChunkId(sha256, base), computeChunkId(sha256, base));
  });

  it("produces a short, fixed-length id", () => {
    assert.equal(computeChunkId(sha256, base).length, 20);
  });

  it("changes when the content changes, so stale vectors cannot be reused", () => {
    const edited = computeChunkId(sha256, { ...base, text: "hello THERE" });
    assert.notEqual(computeChunkId(sha256, base), edited);
  });

  it("changes when the position changes", () => {
    assert.notEqual(computeChunkId(sha256, base), computeChunkId(sha256, { ...base, ordinal: 1 }));
    assert.notEqual(computeChunkId(sha256, base), computeChunkId(sha256, { ...base, startChar: 1 }));
    assert.notEqual(computeChunkId(sha256, base), computeChunkId(sha256, { ...base, endChar: 11 }));
  });

  it("changes when the document changes", () => {
    assert.notEqual(
      computeChunkId(sha256, base),
      computeChunkId(sha256, { ...base, ref: "docs/b.md" }),
    );
  });

  it("separates fields so two different inputs cannot hash the same", () => {
    // Without a separator, ref "docs/a" + ordinal "0" would concatenate to the
    // same string as ref "docs/a0" + ordinal "".
    const left = computeChunkId(sha256, { ...base, ref: "docs/a", ordinal: 0 });
    const right = computeChunkId(sha256, { ...base, ref: "docs/a0", ordinal: 0 });
    assert.notEqual(left, right);
  });
});
