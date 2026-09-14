import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeSourceSpec } from "../../infrastructure/source/source-reader-factory.ts";
import type { ExtractedDocument, SourceReader } from "./sources.ts";

/**
 * Interface-level invariants. The concrete readers and extractors have their
 * own specs; this states what any implementation must hold to.
 */
describe("application/ports/sources", () => {
  describe("SourceReader", () => {
    const reader: SourceReader = {
      spec: normalizeSourceSpec({ id: "docs", uri: "/tmp" }),
      revision: () => null,
      discover: () => [],
      exclusions: () => [],
      resolve: () => null,
    };

    it("carries the spec that produced it", () => {
      assert.equal(reader.spec.id, "docs");
    });

    it("may report no revision, which callers must treat as 'unverifiable'", () => {
      assert.equal(reader.revision(), null);
    });

    it("returns arrays, never undefined, so callers need no guards", () => {
      assert.ok(Array.isArray(reader.discover()));
      assert.ok(Array.isArray(reader.exclusions()));
    });
  });

  describe("ExtractedDocument", () => {
    it("carries complete text plus the metadata needed to cite it", () => {
      const extracted: ExtractedDocument = {
        text: "line one\nline two",
        title: "Title",
        mediaType: "text/markdown",
        pageBreaks: [],
        tags: [],
        links: [],
        notes: [],
      };
      assert.equal(extracted.text.split("\n").length, 2);
      assert.deepEqual(extracted.pageBreaks, [], "unpaginated sources report no pages");
    });

    it("represents pagination as ordered (offset, page) pairs", () => {
      const paginated: ExtractedDocument = {
        text: "page one\npage two\n",
        title: "Doc",
        mediaType: "application/pdf",
        pageBreaks: [
          [0, 1],
          [9, 2],
        ],
        tags: [],
        links: [],
        notes: [],
      };
      const offsets = paginated.pageBreaks.map(([offset]) => offset);
      assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
    });
  });
});
