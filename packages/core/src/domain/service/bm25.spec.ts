import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_BM25,
  type CorpusStatistics,
  type Posting,
  inverseDocumentFrequency,
  rankScores,
  scoreBm25,
} from "./bm25.ts";

const corpus: CorpusStatistics = { chunkCount: 100, averageTokenCount: 50 };
const query = new Map([["token", 1]]);

function posting(overrides: Partial<Posting> = {}): Posting {
  return { term: "token", chunkId: "c1", tf: 3, df: 10, tokenCount: 50, ...overrides };
}

describe("domain/service/bm25", () => {
  describe("inverseDocumentFrequency", () => {
    it("gives rare terms more weight than common ones", () => {
      assert.ok(inverseDocumentFrequency(1000, 2) > inverseDocumentFrequency(1000, 500));
    });

    it("never goes negative for a term present in every chunk", () => {
      assert.ok(inverseDocumentFrequency(100, 100) >= 0);
    });

    it("treats a zero document frequency as one, avoiding a divide-by-zero", () => {
      assert.equal(inverseDocumentFrequency(100, 0), inverseDocumentFrequency(100, 1));
      assert.ok(Number.isFinite(inverseDocumentFrequency(100, 0)));
    });
  });

  describe("scoreBm25", () => {
    it("returns nothing for an empty corpus rather than dividing by zero", () => {
      assert.equal(scoreBm25([posting()], query, { chunkCount: 0, averageTokenCount: 0 }).size, 0);
    });

    it("scores a matching chunk above zero", () => {
      const scores = scoreBm25([posting()], query, corpus);
      assert.ok((scores.get("c1") ?? 0) > 0);
    });

    it("ignores postings for terms the query did not ask for", () => {
      const scores = scoreBm25([posting({ term: "unrelated" })], query, corpus);
      assert.equal(scores.size, 0);
    });

    it("sums contributions across query terms", () => {
      const multi = new Map([
        ["token", 1],
        ["jwt", 1],
      ]);
      const single = scoreBm25([posting()], multi, corpus).get("c1") ?? 0;
      const both = scoreBm25([posting(), posting({ term: "jwt" })], multi, corpus).get("c1") ?? 0;
      assert.ok(both > single, "matching two query terms must beat matching one");
    });

    it("prefers a rarer term over a common one", () => {
      const rare = scoreBm25([posting({ df: 2 })], query, corpus).get("c1") ?? 0;
      const common = scoreBm25([posting({ df: 90 })], query, corpus).get("c1") ?? 0;
      assert.ok(rare > common);
    });

    it("saturates term frequency instead of scaling linearly", () => {
      const one = scoreBm25([posting({ tf: 1 })], query, corpus).get("c1") ?? 0;
      const ten = scoreBm25([posting({ tf: 10 })], query, corpus).get("c1") ?? 0;
      assert.ok(ten > one, "more occurrences should still score higher");
      assert.ok(ten < one * 10, "but with diminishing returns, not linearly");
    });

    it("penalizes a long chunk relative to a short one with the same term count", () => {
      const short = scoreBm25([posting({ tokenCount: 10 })], query, corpus).get("c1") ?? 0;
      const long = scoreBm25([posting({ tokenCount: 500 })], query, corpus).get("c1") ?? 0;
      assert.ok(short > long, "length normalization should favour the denser chunk");
    });

    it("honours a repeated query term as extra weight", () => {
      const once = scoreBm25([posting()], new Map([["token", 1]]), corpus).get("c1") ?? 0;
      const twice = scoreBm25([posting()], new Map([["token", 2]]), corpus).get("c1") ?? 0;
      assert.ok(Math.abs(twice - once * 2) < 1e-9);
    });

    it("disables length normalization when b is zero", () => {
      const params = { ...DEFAULT_BM25, b: 0 };
      const short = scoreBm25([posting({ tokenCount: 10 })], query, corpus, params).get("c1") ?? 0;
      const long = scoreBm25([posting({ tokenCount: 500 })], query, corpus, params).get("c1") ?? 0;
      assert.ok(Math.abs(short - long) < 1e-9);
    });

    it("guards against a zero-length chunk", () => {
      const score = scoreBm25([posting({ tokenCount: 0 })], query, corpus).get("c1");
      assert.ok(Number.isFinite(score ?? Number.NaN));
    });
  });

  describe("rankScores", () => {
    it("orders by score, highest first", () => {
      const scores = new Map([
        ["a", 0.1],
        ["b", 0.9],
        ["c", 0.5],
      ]);
      assert.deepEqual(
        rankScores(scores, 3).map(([id]) => id),
        ["b", "c", "a"],
      );
    });

    it("breaks ties on id so repeated queries return a stable order", () => {
      const scores = new Map([
        ["zeta", 1],
        ["alpha", 1],
        ["mid", 1],
      ]);
      assert.deepEqual(
        rankScores(scores, 3).map(([id]) => id),
        ["alpha", "mid", "zeta"],
      );
    });

    it("truncates to topK", () => {
      const scores = new Map([
        ["a", 3],
        ["b", 2],
        ["c", 1],
      ]);
      assert.equal(rankScores(scores, 2).length, 2);
    });

    it("returns everything for a negative topK", () => {
      assert.equal(rankScores(new Map([["a", 1]]), -1).length, 1);
    });
  });
});
