import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryStore } from "../../__fixtures__/in-memory-store.ts";
import { RefNotFoundError } from "../../domain/errors.ts";
import { WarningCode } from "../dto/contracts.ts";
import { parseRefWithRange, readDocument } from "./read-document.ts";

const TEXT = "line one\nline two\nline three\nline four\nline five\n";

function store(): InMemoryStore {
  const memory = new InMemoryStore();
  memory.addDocument({ ref: "docs/a.md", title: "Doc A", text: TEXT, revision: "abc" });
  return memory;
}

const deps = (memory: InMemoryStore) => ({ store: memory, corpusName: "test" });

describe("application/usecase/readDocument", () => {
  describe("parseRefWithRange", () => {
    it("parses a bare ref", () => {
      assert.deepEqual(parseRefWithRange("docs/a.md"), {
        ref: "docs/a.md",
        startLine: null,
        endLine: null,
        page: null,
      });
    });

    it("parses a line range as emitted by read_ref", () => {
      assert.deepEqual(parseRefWithRange("docs/a.md#L10-L24"), {
        ref: "docs/a.md",
        startLine: 10,
        endLine: 24,
        page: null,
      });
    });

    it("parses a single-line citation", () => {
      assert.deepEqual(parseRefWithRange("docs/a.md#L7"), {
        ref: "docs/a.md",
        startLine: 7,
        endLine: 7,
        page: null,
      });
    });

    it("parses a page-qualified citation", () => {
      assert.deepEqual(parseRefWithRange("docs/a.pdf#p3L4-L9"), {
        ref: "docs/a.pdf",
        startLine: 4,
        endLine: 9,
        page: 3,
      });
    });

    it("treats a non-range anchor as part of no range", () => {
      assert.deepEqual(parseRefWithRange("docs/a.md#section-title"), {
        ref: "docs/a.md",
        startLine: null,
        endLine: null,
        page: null,
      });
    });
  });

  describe("reading", () => {
    it("returns the whole document by default", () => {
      const result = readDocument({ ref: "docs/a.md" }, deps(store()));
      assert.equal(result.text, TEXT);
      assert.equal(result.totalLines, 5);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.warnings, []);
    });

    it("returns the requested line range", () => {
      const result = readDocument({ ref: "docs/a.md", startLine: 2, endLine: 3 }, deps(store()));
      assert.equal(result.text, "line two\nline three");
      assert.equal(result.location.startLine, 2);
      assert.equal(result.location.endLine, 3);
    });

    it("accepts the range inline in the ref, so a hit round-trips", () => {
      const result = readDocument({ ref: "docs/a.md#L2-L3" }, deps(store()));
      assert.equal(result.text, "line two\nline three");
    });

    it("reports character offsets that re-extract the same text", () => {
      const result = readDocument({ ref: "docs/a.md#L2-L3" }, deps(store()));
      assert.equal(TEXT.slice(result.location.startChar, result.location.endChar), result.text);
    });

    it("carries the source revision for pinning a citation", () => {
      assert.equal(readDocument({ ref: "docs/a.md" }, deps(store())).sourceRevision, "abc");
    });

    it("preserves the page for a paginated citation", () => {
      const result = readDocument({ ref: "docs/a.md#p3L2-L3" }, deps(store()));
      assert.equal(result.location.page, 3);
    });
  });

  describe("clamping and truncation", () => {
    it("clamps an over-long range and says so", () => {
      const result = readDocument({ ref: "docs/a.md#L4-L99" }, deps(store()));
      assert.equal(result.location.endLine, 5);
      assert.ok(result.warnings.some((w) => w.code === WarningCode.RANGE_CLAMPED));
    });

    it("does not warn when the range fits exactly", () => {
      const result = readDocument({ ref: "docs/a.md#L1-L5" }, deps(store()));
      assert.deepEqual(result.warnings, []);
    });

    it("flags truncation rather than shortening silently", () => {
      const result = readDocument({ ref: "docs/a.md", maxChars: 10 }, deps(store()));
      assert.equal(result.truncated, true);
      assert.equal(result.text.length, 10);
      assert.ok(result.warnings.some((w) => w.code === WarningCode.RANGE_CLAMPED));
    });

    it("reports the full line count even when truncated", () => {
      const result = readDocument({ ref: "docs/a.md", maxChars: 10 }, deps(store()));
      assert.equal(result.totalLines, 5);
    });
  });

  describe("missing documents", () => {
    it("throws a typed error naming the ref", () => {
      assert.throws(
        () => readDocument({ ref: "docs/missing.md" }, deps(store())),
        (error: unknown) => {
          assert.ok(error instanceof RefNotFoundError);
          assert.equal(error.details["ref"], "docs/missing.md");
          assert.match(String(error.details["hint"]), /search/);
          return true;
        },
      );
    });

    it("throws for a ref that exists only with a range", () => {
      assert.throws(() => readDocument({ ref: "docs/missing.md#L1-L2" }, deps(store())), RefNotFoundError);
    });
  });
});
