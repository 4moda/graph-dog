import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_BM25, inverseDocumentFrequency, rankScores, scoreBm25, termCoverage, type CorpusStatistics, type Posting } from "./bm25.ts";

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

describe("domain/service/bm25: termCoverage", () => {
  const corpus = { chunkCount: 100, averageTokenCount: 50 };
  const posting = (term: string, chunkId: string, df: number, tf = 1) => ({
    term,
    chunkId,
    tf,
    df,
    tokenCount: 50,
  });

  it("gives 1 to a chunk holding every term the query asked for", () => {
    const coverage = termCoverage(
      [posting("jwks", "a", 5), posting("rotation", "a", 5)],
      new Map([["jwks", 1], ["rotation", 1]]),
      corpus,
    );
    assert.ok(Math.abs((coverage.get("a") ?? 0) - 1) < 1e-9);
  });

  it("leaves out a chunk that holds none of them", () => {
    const coverage = termCoverage([posting("jwks", "a", 5)], new Map([["jwks", 1]]), corpus);
    assert.equal(coverage.get("b"), undefined);
  });

  it("counts a rare term for more than a common one", () => {
    // Sharing "published" with a question is not covering it; sharing
    // "chromodynamics" very nearly is.
    const coverage = termCoverage(
      [posting("common", "a", 90), posting("rare", "b", 1)],
      new Map([["common", 1], ["rare", 1]]),
      corpus,
    );
    assert.ok((coverage.get("b") ?? 0) > (coverage.get("a") ?? 0) * 3, JSON.stringify([...coverage]));
  });

  it("charges the query for a term no chunk in the corpus contains", () => {
    // This is what makes an absent answer detectable: asking for something the
    // corpus does not have has to lower every chunk's coverage.
    const withAbsent = termCoverage(
      [posting("jwks", "a", 5)],
      new Map([["jwks", 1], ["sourdough", 1]]),
      corpus,
    );
    const without = termCoverage([posting("jwks", "a", 5)], new Map([["jwks", 1]]), corpus);
    assert.ok((withAbsent.get("a") ?? 0) < (without.get("a") ?? 0));
    assert.equal(without.get("a"), 1);
  });

  it("does not pay a chunk twice for repeating a term", () => {
    const once = termCoverage([posting("jwks", "a", 5, 1)], new Map([["jwks", 1]]), corpus);
    const many = termCoverage([posting("jwks", "a", 5, 40)], new Map([["jwks", 1]]), corpus);
    assert.equal(many.get("a"), once.get("a"), "coverage is about breadth, tf is BM25's job");
  });

  it("stays between 0 and 1 whatever it is given", () => {
    const coverage = termCoverage(
      [posting("a", "x", 1), posting("b", "x", 1), posting("c", "x", 99)],
      new Map([["a", 3], ["b", 1], ["c", 1], ["absent", 1]]),
      corpus,
    );
    for (const value of coverage.values()) assert.ok(value >= 0 && value <= 1, String(value));
  });

  it("is empty for an empty query or an empty corpus", () => {
    assert.equal(termCoverage([posting("a", "x", 1)], new Map(), corpus).size, 0);
    assert.equal(
      termCoverage([posting("a", "x", 1)], new Map([["a", 1]]), { chunkCount: 0, averageTokenCount: 0 }).size,
      0,
    );
  });
});
