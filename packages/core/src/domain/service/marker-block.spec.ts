import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../errors.ts";
import {
  hasBlock,
  hashMarkers,
  htmlMarkers,
  removeBlock,
  upsertBlock,
} from "./marker-block.ts";

const MARKERS = htmlMarkers("graphdog");
const OTHER = htmlMarkers("code-review-graph");

describe("domain/service/marker-block", () => {
  describe("upsertBlock", () => {
    it("writes the block into an empty file with no leading blank line", () => {
      assert.equal(upsertBlock("", MARKERS, "Search first."), "<!-- graphdog -->\nSearch first.\n<!-- /graphdog -->\n");
    });

    it("appends after existing text, separated by one blank line", () => {
      const out = upsertBlock("# Handbook\n", MARKERS, "Search first.");
      assert.equal(out, "# Handbook\n\n<!-- graphdog -->\nSearch first.\n<!-- /graphdog -->\n");
    });

    it("separates with exactly one blank line however many the file ended with", () => {
      const out = upsertBlock("# Handbook\n\n\n\n", MARKERS, "body");
      assert.equal(out, "# Handbook\n\n<!-- graphdog -->\nbody\n<!-- /graphdog -->\n");
    });

    it("terminates a last line that had no newline", () => {
      const out = upsertBlock("no trailing newline", MARKERS, "body");
      assert.equal(out, "no trailing newline\n\n<!-- graphdog -->\nbody\n<!-- /graphdog -->\n");
    });

    it("replaces the body in place, leaving what surrounds it alone", () => {
      const before = "# Top\n\n<!-- graphdog -->\nold\n<!-- /graphdog -->\n\n## After\n";
      const after = upsertBlock(before, MARKERS, "new");
      assert.equal(after, "# Top\n\n<!-- graphdog -->\nnew\n<!-- /graphdog -->\n\n## After\n");
    });

    it("leaves another tool's block in the same file untouched", () => {
      const theirs = "<!-- code-review-graph -->\ntheirs\n<!-- /code-review-graph -->\n";
      const out = upsertBlock(theirs, MARKERS, "ours");
      assert.ok(out.includes(theirs), "the other tool's block must survive verbatim");
      assert.ok(hasBlock(out, OTHER) && hasBlock(out, MARKERS));
    });

    it("is idempotent: writing the same body twice changes nothing the second time", () => {
      const once = upsertBlock("# Handbook\n", MARKERS, "body");
      assert.equal(upsertBlock(once, MARKERS, "body"), once);
    });

    it("normalizes trailing blank lines in the body, so a rewrite is not a diff", () => {
      assert.equal(upsertBlock("", MARKERS, "body\n\n\n"), upsertBlock("", MARKERS, "body"));
    });
  });

  describe("removeBlock", () => {
    it("gives back exactly the text an insert started from", () => {
      for (const before of ["", "# Handbook\n", "a\n\nb\n"]) {
        const withBlock = upsertBlock(before, MARKERS, "body");
        assert.equal(removeBlock(withBlock, MARKERS), before, `round trip failed for ${JSON.stringify(before)}`);
      }
    });

    it("normalizes how the file ended, which is the price of leaving no debris", () => {
      // Two blank lines before the block and removal cannot tell the one it
      // added from the one that was there. One trailing newline -- what a file
      // normally ends with -- survives untouched, which is the case above.
      for (const [before, after] of [["# Handbook\n\n\n", "# Handbook\n"], ["no newline", "no newline\n"]]) {
        assert.equal(removeBlock(upsertBlock(before ?? "", MARKERS, "body"), MARKERS), after);
      }
    });

    it("reports null when the file never had a block of ours", () => {
      assert.equal(removeBlock("# Handbook\n", MARKERS), null);
    });

    it("removes only ours when another tool shares the file", () => {
      const theirs = "<!-- code-review-graph -->\ntheirs\n<!-- /code-review-graph -->\n";
      const both = upsertBlock(theirs, MARKERS, "ours");
      assert.equal(removeBlock(both, MARKERS), theirs);
    });

    it("leaves the file empty, not holding a stray newline", () => {
      assert.equal(removeBlock(upsertBlock("", MARKERS, "body"), MARKERS), "");
    });
  });

  describe("a file edited by hand", () => {
    it("refuses a block whose closing marker was deleted", () => {
      assert.throws(
        () => upsertBlock("<!-- graphdog -->\nbody\n", MARKERS, "new"),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /malformed/);
          return true;
        },
      );
    });

    it("refuses markers that appear in the wrong order", () => {
      assert.throws(() => removeBlock("<!-- /graphdog -->\n<!-- graphdog -->\n", MARKERS), ConfigError);
    });

    it("ignores a marker quoted inside a line rather than standing alone", () => {
      const prose = "The block is delimited by <!-- graphdog --> and its closing form.\n";
      assert.equal(hasBlock(prose, MARKERS), false);
      assert.match(upsertBlock(prose, MARKERS, "body"), /^The block[\s\S]*<!-- graphdog -->\nbody\n/);
    });

    it("tolerates trailing whitespace on a marker line", () => {
      assert.equal(hasBlock("<!-- graphdog -->  \nbody\n<!-- /graphdog -->\n", MARKERS), true);
    });
  });

  describe("hashMarkers", () => {
    it("comments the way a shell script does", () => {
      assert.deepEqual(hashMarkers("graphdog"), { open: "# >>> graphdog", close: "# <<< graphdog" });
    });

    it("round-trips in a hook script", () => {
      const script = "#!/bin/sh\nset -e\nexec other-tool\n";
      const out = upsertBlock(script, hashMarkers("graphdog"), "graphdog update --quiet || true");
      assert.equal(removeBlock(out, hashMarkers("graphdog")), script);
    });
  });
});
