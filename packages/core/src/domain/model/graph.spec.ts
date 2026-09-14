import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EDGE_DECAY,
  UNKNOWN_EDGE_DECAY,
  decayFor,
  describeEdge,
  directoryNodeId,
  documentNodeId,
  refFromNodeId,
  tagNodeId,
} from "./graph.ts";

describe("domain/model/graph", () => {
  describe("node ids", () => {
    it("namespaces each node kind so ids cannot collide", () => {
      assert.equal(documentNodeId("docs/a.md"), "doc:docs/a.md");
      assert.equal(tagNodeId("auth"), "tag:auth");
      assert.equal(directoryNodeId("docs/design"), "dir:docs/design");
    });

    it("round-trips a document ref", () => {
      assert.equal(refFromNodeId(documentNodeId("docs/a.md")), "docs/a.md");
    });

    it("returns null for non-document nodes", () => {
      assert.equal(refFromNodeId(tagNodeId("auth")), null);
      assert.equal(refFromNodeId(directoryNodeId("docs")), null);
    });

    it("round-trips a ref that itself contains a colon", () => {
      assert.equal(refFromNodeId(documentNodeId("docs/a:b.md")), "docs/a:b.md");
    });
  });

  describe("decay", () => {
    it("trusts authored links more than incidental co-location", () => {
      assert.ok(
        EDGE_DECAY.links_to > EDGE_DECAY.same_directory,
        "an explicit link should outrank sharing a folder",
      );
    });

    it("keeps every decay a proper fraction so scores strictly shrink per hop", () => {
      for (const [kind, value] of Object.entries(EDGE_DECAY)) {
        assert.ok(value > 0 && value < 1, `${kind} decay ${value} must be in (0, 1)`);
      }
    });

    it("falls back to a conservative decay for unknown kinds", () => {
      assert.equal(decayFor("invented_later"), UNKNOWN_EDGE_DECAY);
      assert.ok(
        UNKNOWN_EDGE_DECAY <= Math.min(...Object.values(EDGE_DECAY)),
        "an unknown edge must never outrank a known one",
      );
    });

    it("resolves known kinds from the table", () => {
      assert.equal(decayFor("links_to"), EDGE_DECAY.links_to);
    });
  });

  describe("describeEdge", () => {
    it("gives every known kind a readable phrase", () => {
      for (const kind of Object.keys(EDGE_DECAY)) {
        assert.doesNotMatch(describeEdge(kind), /^is related to/, `${kind} needs a real phrase`);
      }
    });

    it("degrades readably for an unknown kind", () => {
      assert.equal(describeEdge("mentions"), "is related to (mentions)");
    });
  });
});
