import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createScores, dominantSignal } from "./scores.ts";

describe("domain/model/scores", () => {
  it("defaults every unreported signal to null, never to zero", () => {
    const scores = createScores({ final: 0.5 });
    assert.equal(scores.dense, null);
    assert.equal(scores.bm25, null);
    assert.equal(scores.graph, null);
    assert.equal(scores.rerank, null);
    assert.equal(scores.final, 0.5);
  });

  it("preserves an explicit zero, which means 'ran and found nothing'", () => {
    const scores = createScores({ final: 0.1, bm25: 0 });
    assert.equal(scores.bm25, 0, "explicit 0 must not collapse to null");
  });

  describe("dominantSignal", () => {
    it("names the strongest retrieval signal", () => {
      assert.equal(dominantSignal(createScores({ final: 1, dense: 0.9, bm25: 0.2 })), "dense");
      assert.equal(dominantSignal(createScores({ final: 1, dense: 0.2, bm25: 0.9 })), "bm25");
    });

    it("names the graph only when no direct signal found the chunk", () => {
      assert.equal(dominantSignal(createScores({ final: 1, graph: 0.4, bm25: 0, dense: 0 })), "graph");
      assert.equal(
        dominantSignal(createScores({ final: 1, graph: 0.9, bm25: 0.1 })),
        "bm25",
        "BM25 retrieved it and fusion ranked it on BM25 alone; the graph did not place it",
      );
    });

    it("ignores rerank, which reorders rather than retrieves", () => {
      const scores = createScores({ final: 1, dense: 0.3, rerank: 0.99 });
      assert.equal(dominantSignal(scores), "dense");
    });

    it("reports 'none' when no signal contributed", () => {
      assert.equal(dominantSignal(createScores({ final: 0 })), "none");
      assert.equal(dominantSignal(createScores({ final: 0, dense: 0, bm25: 0 })), "none");
    });

    it("breaks ties toward the earlier-declared signal", () => {
      const scores = createScores({ final: 1, dense: 0.5, bm25: 0.5 });
      assert.equal(dominantSignal(scores), "dense");
    });
  });
});
