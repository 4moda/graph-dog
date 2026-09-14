import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_FUSION, fuse, normalize, rankFused } from "./fusion.ts";

describe("domain/service/fusion", () => {
  describe("normalize", () => {
    it("maps the range onto [0, 1]", () => {
      const result = normalize(new Map([["a", 10], ["b", 20], ["c", 30]]));
      assert.equal(result.get("a"), 0);
      assert.equal(result.get("c"), 1);
      assert.ok(Math.abs((result.get("b") ?? 0) - 0.5) < 1e-9);
    });

    it("maps a lone result to 1, not 0", () => {
      assert.equal(normalize(new Map([["a", 0.3]])).get("a"), 1);
    });

    it("maps an all-equal set to 1 rather than dividing by zero", () => {
      const result = normalize(new Map([["a", 5], ["b", 5]]));
      assert.equal(result.get("a"), 1);
      assert.equal(result.get("b"), 1);
    });

    it("is empty for empty input", () => {
      assert.equal(normalize(new Map()).size, 0);
    });
  });

  describe("signal reporting", () => {
    it("reports null for a signal that did not run", () => {
      const fused = fuse({ dense: [["a", 0.9]], bm25: null, graph: null });
      assert.equal(fused.get("a")?.bm25, null);
      assert.equal(fused.get("a")?.graph, null);
      assert.notEqual(fused.get("a")?.dense, null);
    });

    it("reports zero for a signal that ran but missed this chunk", () => {
      const fused = fuse({ dense: [["a", 0.9]], bm25: [["b", 2]], graph: null });
      assert.equal(fused.get("a")?.bm25, 0, "BM25 ran and did not match: that is 0, not null");
    });
  });

  describe("rrf", () => {
    it("ranks a chunk found by both signals above one found by only one", () => {
      const fused = fuse({
        dense: [["both", 0.8], ["denseOnly", 0.9]],
        bm25: [["both", 5], ["bm25Only", 9]],
        graph: null,
      });
      const order = rankFused(fused).map(([id]) => id);
      assert.equal(order[0], "both", order.join(" > "));
    });

    it("is immune to signal scale, unlike a raw weighted sum", () => {
      const small = fuse({ dense: [["a", 0.9], ["b", 0.1]], bm25: [["b", 3], ["a", 1]], graph: null });
      const huge = fuse({
        dense: [["a", 0.9], ["b", 0.1]],
        bm25: [["b", 3_000_000], ["a", 1_000_000]],
        graph: null,
      });
      assert.deepEqual(rankFused(small).map(([id]) => id), rankFused(huge).map(([id]) => id));
    });

    it("normalizes the top hit to exactly 1", () => {
      const fused = fuse({ dense: [["a", 0.9], ["b", 0.2]], bm25: null, graph: null });
      assert.equal(rankFused(fused)[0]?.[1].final, 1);
    });

    it("weights the graph below direct retrieval by default", () => {
      const fused = fuse({
        dense: [["direct", 0.5]],
        bm25: null,
        graph: new Map([["viaGraph", 0.9]]),
      });
      const order = rankFused(fused).map(([id]) => id);
      assert.equal(order[0], "direct", "graph proximity should not outrank a direct match");
    });

    it("returns zeros rather than NaN when every signal is empty", () => {
      const fused = fuse({ dense: [], bm25: [], graph: new Map() });
      assert.equal(fused.size, 0);
    });
  });

  describe("weighted", () => {
    const config = { ...DEFAULT_FUSION, strategy: "weighted" as const };

    it("produces a score inside [0, 1]", () => {
      const fused = fuse({ dense: [["a", 0.9], ["b", 0.1]], bm25: [["a", 5], ["b", 1]], graph: null }, config);
      for (const score of fused.values()) {
        assert.ok(score.final >= 0 && score.final <= 1, `final ${score.final} out of range`);
      }
    });

    it("honours relative weights", () => {
      const denseHeavy = { ...config, denseWeight: 10, bm25Weight: 0, graphWeight: 0 };
      const fused = fuse({ dense: [["a", 1], ["b", 0]], bm25: [["b", 9], ["a", 0]], graph: null }, denseHeavy);
      assert.equal(rankFused(fused)[0]?.[0], "a");
    });

    it("does not divide by zero when all weights are zero", () => {
      const zeroed = { ...config, denseWeight: 0, bm25Weight: 0, graphWeight: 0 };
      const fused = fuse({ dense: [["a", 1]], bm25: null, graph: null }, zeroed);
      assert.equal(fused.get("a")?.final, 0);
    });
  });

  describe("rankFused", () => {
    it("breaks ties on chunk id so repeated queries are stable", () => {
      const fused = fuse({ dense: [["zeta", 1], ["alpha", 1]], bm25: null, graph: null });
      assert.deepEqual(rankFused(fused).map(([id]) => id), ["alpha", "zeta"]);
    });
  });
});
