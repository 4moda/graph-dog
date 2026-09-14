import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countLines, createLocation, formatLocation, lineAt, lineStarts } from "./location.ts";

describe("domain/model/location", () => {
  it("defaults page to null so the field is always present", () => {
    const location = createLocation({ startLine: 1, endLine: 2, startChar: 0, endChar: 9 });
    assert.equal(location.page, null);
  });

  it("formats a single-line citation without a range", () => {
    const location = createLocation({ startLine: 7, endLine: 7, startChar: 0, endChar: 1 });
    assert.equal(formatLocation(location), "#L7");
  });

  it("formats a multi-line citation as a range", () => {
    const location = createLocation({ startLine: 7, endLine: 12, startChar: 0, endChar: 1 });
    assert.equal(formatLocation(location), "#L7-L12");
  });

  it("includes the page for paginated sources", () => {
    const location = createLocation({ startLine: 2, endLine: 4, startChar: 0, endChar: 1, page: 3 });
    assert.equal(formatLocation(location), "#p3L2-L4");
  });

  describe("lineStarts / lineAt", () => {
    const text = "alpha\nbeta\ngamma";
    const starts = lineStarts(text);

    it("records the offset of every line start", () => {
      assert.deepEqual(starts, [0, 6, 11]);
    });

    it("maps offsets back to 1-based line numbers", () => {
      assert.equal(lineAt(0, starts), 1);
      assert.equal(lineAt(5, starts), 1);
      assert.equal(lineAt(6, starts), 2);
      assert.equal(lineAt(10, starts), 2);
      assert.equal(lineAt(11, starts), 3);
      assert.equal(lineAt(15, starts), 3);
    });

    it("agrees with a naive scan for every offset", () => {
      for (let offset = 0; offset < text.length; offset += 1) {
        const expected = text.slice(0, offset).split("\n").length;
        assert.equal(lineAt(offset, starts), expected, `offset ${offset}`);
      }
    });

    it("handles a single-line document", () => {
      assert.deepEqual(lineStarts("no newlines"), [0]);
      assert.equal(lineAt(4, lineStarts("no newlines")), 1);
    });
  });

  describe("countLines", () => {
    it("counts an empty document as zero lines", () => {
      assert.equal(countLines(""), 0);
    });

    it("does not invent a trailing empty line", () => {
      assert.equal(countLines("a\nb\n"), 2);
    });

    it("counts a document with no trailing newline", () => {
      assert.equal(countLines("a\nb"), 2);
    });

    it("counts a single line", () => {
      assert.equal(countLines("a"), 1);
    });
  });
});
