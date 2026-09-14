import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeRef, pageAt, parseRef, refBasename, refDirectory, sliceLines } from "./document.ts";

describe("domain/model/document", () => {
  describe("makeRef", () => {
    it("builds a posix ref from a source id and relative path", () => {
      assert.equal(makeRef("docs", "designs/token.md"), "docs/designs/token.md");
    });

    it("normalizes Windows separators so refs are platform-independent", () => {
      assert.equal(makeRef("docs", "designs\\infra\\token.md"), "docs/designs/infra/token.md");
    });

    it("collapses repeated and leading separators", () => {
      assert.equal(makeRef("docs", "/a//b/c.md"), "docs/a/b/c.md");
    });

    it("drops '.' segments", () => {
      assert.equal(makeRef("docs", "./a/./b.md"), "docs/a/b.md");
    });

    it("resolves '..' so a ref can never escape its source", () => {
      assert.equal(makeRef("docs", "a/../b.md"), "docs/b.md");
      assert.equal(makeRef("docs", "../../etc/passwd"), "docs/etc/passwd");
    });
  });

  describe("parseRef", () => {
    it("splits a ref into source id and relative path", () => {
      assert.deepEqual(parseRef("docs/a/b.md"), { sourceId: "docs", relativePath: "a/b.md" });
    });

    it("rejects a ref with no path part", () => {
      assert.equal(parseRef("docs"), null);
      assert.equal(parseRef("docs/"), null);
      assert.equal(parseRef("/a.md"), null);
    });
  });

  describe("refDirectory / refBasename", () => {
    it("splits a nested ref", () => {
      assert.equal(refDirectory("docs/a/b.md"), "docs/a");
      assert.equal(refBasename("docs/a/b.md"), "b.md");
    });

    it("treats a source-root document as having a source-level directory", () => {
      assert.equal(refDirectory("docs/b.md"), "docs");
      assert.equal(refBasename("docs/b.md"), "b.md");
    });
  });

  describe("pageAt", () => {
    const breaks: ReadonlyArray<readonly [number, number]> = [
      [0, 1],
      [100, 2],
      [250, 3],
    ];

    it("returns null when the document is not paginated", () => {
      assert.equal(pageAt(10, []), null);
    });

    it("maps offsets to the page containing them", () => {
      assert.equal(pageAt(0, breaks), 1);
      assert.equal(pageAt(99, breaks), 1);
      assert.equal(pageAt(100, breaks), 2);
      assert.equal(pageAt(249, breaks), 2);
      assert.equal(pageAt(1000, breaks), 3);
    });
  });

  describe("sliceLines", () => {
    const text = "one\ntwo\nthree\nfour\n";

    it("extracts an inclusive 1-based range", () => {
      assert.deepEqual(sliceLines(text, 2, 3), { text: "two\nthree", startLine: 2, endLine: 3 });
    });

    it("clamps a range that runs past the end and reports what it returned", () => {
      const result = sliceLines(text, 3, 99);
      assert.equal(result.text, "three\nfour");
      assert.equal(result.endLine, 4, "clamped bound is reported, not the requested one");
    });

    it("clamps a start line below 1", () => {
      assert.deepEqual(sliceLines(text, 0, 1), { text: "one", startLine: 1, endLine: 1 });
    });

    it("handles an inverted range by returning a single line", () => {
      assert.deepEqual(sliceLines(text, 3, 1), { text: "three", startLine: 3, endLine: 3 });
    });

    it("handles empty text without throwing", () => {
      assert.deepEqual(sliceLines("", 1, 5), { text: "", startLine: 1, endLine: 1 });
    });
  });
});
