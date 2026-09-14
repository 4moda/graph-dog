import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aggregate,
  dedupeByRef,
  evidenceAccuracy,
  indexJudgments,
  mean,
  ndcgAtK,
  percentile,
  precisionAtK,
  reciprocalRank,
  recallAtK,
  scoreQuery,
  spansOverlap,
  type Judgment,
  type RetrievedItem,
} from "./metrics.ts";

/** Ranked results, with spans that do not matter unless the test says so. */
function ranked(...refs: string[]): RetrievedItem[] {
  return refs.map((ref) => ({ ref, startLine: 1, endLine: 10 }));
}

function judged(...refs: string[]): Map<string, Judgment> {
  return indexJudgments(refs.map((ref) => ({ ref, grade: 1 })));
}

describe("domain/service/metrics", () => {
  describe("indexJudgments", () => {
    it("keys judgments by ref", () => {
      const index = indexJudgments([{ ref: "a.md", grade: 2 }]);
      assert.equal(index.get("a.md")?.grade, 2);
    });

    it("keeps the stronger grade when a ref is judged twice", () => {
      // A dataset listing one document once per expected passage must not be
      // scored as though the last entry overrode the first.
      const index = indexJudgments([
        { ref: "a.md", grade: 1, startLine: 1, endLine: 5 },
        { ref: "a.md", grade: 3, startLine: 20, endLine: 25 },
      ]);
      assert.equal(index.get("a.md")?.grade, 3);
    });
  });

  describe("dedupeByRef", () => {
    it("keeps the best-ranked occurrence of each document", () => {
      const items: RetrievedItem[] = [
        { ref: "a.md", startLine: 1, endLine: 5 },
        { ref: "a.md", startLine: 40, endLine: 50 },
        { ref: "b.md", startLine: 1, endLine: 5 },
      ];
      const deduped = dedupeByRef(items);
      assert.deepEqual(deduped.map((item) => item.ref), ["a.md", "b.md"]);
      assert.equal(deduped[0]?.startLine, 1, "the higher-ranked chunk should win");
    });

    it("leaves an already-unique list alone", () => {
      assert.deepEqual(dedupeByRef(ranked("a.md", "b.md")).map((i) => i.ref), ["a.md", "b.md"]);
    });
  });

  describe("recallAtK", () => {
    it("is 1 when every relevant document is in the top k", () => {
      assert.equal(recallAtK(ranked("a.md", "b.md"), judged("a.md", "b.md"), 10), 1);
    });

    it("is 0 when none is", () => {
      assert.equal(recallAtK(ranked("x.md", "y.md"), judged("a.md"), 10), 0);
    });

    it("measures the fraction found", () => {
      assert.equal(recallAtK(ranked("a.md", "x.md"), judged("a.md", "b.md"), 10), 0.5);
    });

    it("respects the cutoff", () => {
      // b.md is relevant but sits at rank 3, outside k=2.
      assert.equal(recallAtK(ranked("a.md", "x.md", "b.md"), judged("a.md", "b.md"), 2), 0.5);
    });

    it("counts a document once even when several of its chunks are returned", () => {
      const retrieved: RetrievedItem[] = [
        { ref: "a.md", startLine: 1, endLine: 5 },
        { ref: "a.md", startLine: 6, endLine: 10 },
      ];
      assert.equal(recallAtK(retrieved, judged("a.md", "b.md"), 10), 0.5);
    });

    it("is unmeasurable, not zero, when nothing was judged relevant", () => {
      assert.equal(recallAtK(ranked("a.md"), judged(), 10), null);
    });

    it("ignores judgments graded zero", () => {
      const index = indexJudgments([{ ref: "a.md", grade: 0 }]);
      assert.equal(recallAtK(ranked("a.md"), index, 10), null);
    });
  });

  describe("precisionAtK", () => {
    it("is 1 when every one of the top k is relevant", () => {
      assert.equal(precisionAtK(ranked("a.md", "b.md"), judged("a.md", "b.md"), 2), 1);
    });

    it("divides by k, not by how many were returned", () => {
      // Two returned, both right, but k is 4: precision@4 is 0.5. Dividing by
      // the returned count would score this the same as returning four of four.
      assert.equal(precisionAtK(ranked("a.md", "b.md"), judged("a.md", "b.md"), 4), 0.5);
    });

    it("is 0 when nothing was returned", () => {
      assert.equal(precisionAtK([], judged("a.md"), 5), 0);
    });

    it("is unmeasurable when nothing was judged", () => {
      assert.equal(precisionAtK(ranked("a.md"), judged(), 5), null);
    });
  });

  describe("reciprocalRank", () => {
    it("is 1 when the first result is relevant", () => {
      assert.equal(reciprocalRank(ranked("a.md", "x.md"), judged("a.md")), 1);
    });

    it("is 1/n for a relevant document at rank n", () => {
      assert.equal(reciprocalRank(ranked("x.md", "y.md", "a.md"), judged("a.md")), 1 / 3);
    });

    it("is 0 when no relevant document appears at any rank", () => {
      assert.equal(reciprocalRank(ranked("x.md"), judged("a.md")), 0);
    });

    it("is 0 for an empty result list", () => {
      assert.equal(reciprocalRank([], judged("a.md")), 0);
    });

    it("uses the first relevant document, not the best-graded one", () => {
      const index = indexJudgments([
        { ref: "weak.md", grade: 1 },
        { ref: "strong.md", grade: 3 },
      ]);
      assert.equal(reciprocalRank(ranked("weak.md", "strong.md"), index), 1);
    });

    it("is unmeasurable when nothing was judged", () => {
      assert.equal(reciprocalRank(ranked("a.md"), judged()), null);
    });
  });

  describe("ndcgAtK", () => {
    it("is 1 for the ideal ordering", () => {
      const index = indexJudgments([
        { ref: "best.md", grade: 3 },
        { ref: "good.md", grade: 2 },
        { ref: "ok.md", grade: 1 },
      ]);
      assert.equal(ndcgAtK(ranked("best.md", "good.md", "ok.md"), index, 3), 1);
    });

    it("is below 1 when a weaker document outranks a stronger one", () => {
      const index = indexJudgments([
        { ref: "best.md", grade: 3 },
        { ref: "ok.md", grade: 1 },
      ]);
      const score = ndcgAtK(ranked("ok.md", "best.md"), index, 2);
      assert.ok(score !== null && score < 1 && score > 0, `got ${score}`);
    });

    it("weighs a grade-3 document far above a grade-1 one", () => {
      const index = indexJudgments([
        { ref: "best.md", grade: 3 },
        { ref: "ok.md", grade: 1 },
      ]);
      const withBestFirst = ndcgAtK(ranked("best.md", "ok.md"), index, 2) ?? 0;
      const withOkFirst = ndcgAtK(ranked("ok.md", "best.md"), index, 2) ?? 0;
      assert.ok(withBestFirst - withOkFirst > 0.15, "grading should matter substantially");
    });

    it("is 0 when nothing relevant was returned", () => {
      assert.equal(ndcgAtK(ranked("x.md"), judged("a.md"), 5), 0);
    });

    it("compares against an ideal truncated to k", () => {
      // Three relevant documents but k=1: returning the best possible single
      // result should score 1, not 1/3.
      const index = indexJudgments([
        { ref: "a.md", grade: 1 },
        { ref: "b.md", grade: 1 },
        { ref: "c.md", grade: 1 },
      ]);
      assert.equal(ndcgAtK(ranked("a.md"), index, 1), 1);
    });

    it("is unmeasurable when nothing was judged", () => {
      assert.equal(ndcgAtK(ranked("a.md"), judged(), 5), null);
    });
  });

  describe("spansOverlap", () => {
    it("accepts an exact match", () => {
      assert.ok(spansOverlap({ startLine: 10, endLine: 20 }, { startLine: 10, endLine: 20 }));
    });

    it("accepts partial overlap, since chunk boundaries are not the point", () => {
      assert.ok(spansOverlap({ startLine: 5, endLine: 12 }, { startLine: 10, endLine: 20 }));
      assert.ok(spansOverlap({ startLine: 18, endLine: 30 }, { startLine: 10, endLine: 20 }));
    });

    it("accepts a containing span", () => {
      assert.ok(spansOverlap({ startLine: 1, endLine: 100 }, { startLine: 10, endLine: 20 }));
    });

    it("accepts a single shared line", () => {
      assert.ok(spansOverlap({ startLine: 20, endLine: 25 }, { startLine: 10, endLine: 20 }));
    });

    it("rejects disjoint spans", () => {
      assert.ok(!spansOverlap({ startLine: 1, endLine: 9 }, { startLine: 10, endLine: 20 }));
      assert.ok(!spansOverlap({ startLine: 21, endLine: 30 }, { startLine: 10, endLine: 20 }));
    });
  });

  describe("evidenceAccuracy", () => {
    it("can fall when recall rises, because it is conditional on retrieval", () => {
      // A documented property, not a defect: finding a document for the first
      // time brings its span under test. Anyone gating on this number needs to
      // know it is not monotone with retrieval quality.
      const index = indexJudgments([
        { ref: "a.md", grade: 1, startLine: 10, endLine: 20 },
        { ref: "b.md", grade: 1, startLine: 10, endLine: 20 },
      ]);

      const before = evidenceAccuracy([{ ref: "a.md", startLine: 12, endLine: 18 }], index, 5);
      const after = evidenceAccuracy(
        [
          { ref: "a.md", startLine: 12, endLine: 18 },
          { ref: "b.md", startLine: 90, endLine: 99 },
        ],
        index,
        5,
      );

      assert.equal(before.accuracy, 1);
      assert.equal(after.accuracy, 0.5, "the ratio fell");
      assert.equal(after.correct, before.correct, "while no citation got worse");
      assert.ok(after.checked > before.checked, "the denominator grew");
    });

    it("credits a hit that lands on the expected lines", () => {
      const index = indexJudgments([{ ref: "a.md", grade: 1, startLine: 10, endLine: 20 }]);
      const retrieved: RetrievedItem[] = [{ ref: "a.md", startLine: 12, endLine: 18 }];
      assert.deepEqual(evidenceAccuracy(retrieved, index, 5), {
        checked: 1,
        correct: 1,
        accuracy: 1,
      });
    });

    it("penalizes the right document with the wrong lines", () => {
      // This is the failure no standard IR metric catches: a citation that
      // names the right file but does not check out.
      const index = indexJudgments([{ ref: "a.md", grade: 1, startLine: 10, endLine: 20 }]);
      const retrieved: RetrievedItem[] = [{ ref: "a.md", startLine: 90, endLine: 99 }];
      assert.deepEqual(evidenceAccuracy(retrieved, index, 5), {
        checked: 1,
        correct: 0,
        accuracy: 0,
      });
    });

    it("ignores judgments that pin no span", () => {
      const index = indexJudgments([{ ref: "a.md", grade: 1 }]);
      assert.equal(evidenceAccuracy(ranked("a.md"), index, 5).checked, 0);
    });

    it("does not penalize a document that was never retrieved", () => {
      // A miss is a recall failure and is counted there; counting it twice
      // would conflate two different problems.
      const index = indexJudgments([{ ref: "a.md", grade: 1, startLine: 1, endLine: 5 }]);
      assert.equal(evidenceAccuracy(ranked("other.md"), index, 5).checked, 0);
    });

    it("is unmeasurable when no span was checked", () => {
      assert.equal(evidenceAccuracy(ranked("a.md"), judged("a.md"), 5).accuracy, null);
    });

    it("respects the cutoff", () => {
      const index = indexJudgments([{ ref: "a.md", grade: 1, startLine: 1, endLine: 5 }]);
      assert.equal(evidenceAccuracy(ranked("x.md", "a.md"), index, 1).checked, 0);
    });
  });

  describe("scoreQuery", () => {
    it("reports every metric for one query", () => {
      const metrics = scoreQuery(
        [{ ref: "a.md", startLine: 10, endLine: 20 }, { ref: "x.md", startLine: 1, endLine: 2 }],
        [{ ref: "a.md", grade: 2, startLine: 12, endLine: 15 }],
        5,
      );
      assert.equal(metrics.recallAtK, 1);
      assert.equal(metrics.reciprocalRank, 1);
      assert.equal(metrics.ndcgAtK, 1);
      assert.equal(metrics.evidence.correct, 1);
      assert.equal(metrics.retrieved, 2);
      assert.equal(metrics.relevant, 1);
    });

    it("reports a complete miss without throwing", () => {
      const metrics = scoreQuery(ranked("x.md"), [{ ref: "a.md", grade: 1 }], 5);
      assert.equal(metrics.recallAtK, 0);
      assert.equal(metrics.reciprocalRank, 0);
    });

    it("handles a query that returned nothing", () => {
      const metrics = scoreQuery([], [{ ref: "a.md", grade: 1 }], 5);
      assert.equal(metrics.retrieved, 0);
      assert.equal(metrics.recallAtK, 0);
    });
  });

  describe("mean", () => {
    it("averages the measurable values", () => {
      assert.equal(mean([1, 0, 0.5]), 0.5);
    });

    it("skips nulls rather than treating them as zero", () => {
      assert.equal(mean([1, null, 1]), 1);
    });

    it("is null when nothing is measurable", () => {
      assert.equal(mean([null, null]), null);
      assert.equal(mean([]), null);
    });
  });

  describe("percentile", () => {
    it("returns the nearest-rank value", () => {
      assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
      assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
    });

    it("handles a single value", () => {
      assert.equal(percentile([42], 95), 42);
    });

    it("is null for no values", () => {
      assert.equal(percentile([], 50), null);
    });

    it("does not mutate its input", () => {
      const values = [3, 1, 2];
      percentile(values, 50);
      assert.deepEqual(values, [3, 1, 2]);
    });
  });

  describe("aggregate", () => {
    const perQuery = [
      scoreQuery([{ ref: "a.md", startLine: 1, endLine: 5 }], [{ ref: "a.md", grade: 1, startLine: 1, endLine: 5 }], 5),
      scoreQuery(ranked("x.md"), [{ ref: "b.md", grade: 1 }], 5),
    ];

    it("counts queries and measurable queries", () => {
      assert.equal(aggregate(perQuery).queries, 2);
      assert.equal(aggregate(perQuery).measured, 2);
    });

    it("averages recall across queries", () => {
      assert.equal(aggregate(perQuery).recallAtK, 0.5);
    });

    it("reports MRR", () => {
      assert.equal(aggregate(perQuery).mrr, 0.5);
    });

    it("counts queries that found nothing relevant", () => {
      assert.equal(aggregate(perQuery).missedQueries, 1);
    });

    it("counts queries that returned no results at all", () => {
      const withEmpty = [...perQuery, scoreQuery([], [{ ref: "c.md", grade: 1 }], 5)];
      assert.equal(aggregate(withEmpty).zeroResultQueries, 1);
    });

    it("pools evidence accuracy over judgments, not over queries", () => {
      // One query checking four spans and getting two right, plus one query
      // checking one span and getting it right, is 3/5 -- not the 0.75 that
      // averaging per query would give.
      const many = scoreQuery(
        [
          { ref: "a.md", startLine: 1, endLine: 5 },
          { ref: "b.md", startLine: 1, endLine: 5 },
          { ref: "c.md", startLine: 90, endLine: 95 },
          { ref: "d.md", startLine: 90, endLine: 95 },
        ],
        [
          { ref: "a.md", grade: 1, startLine: 1, endLine: 5 },
          { ref: "b.md", grade: 1, startLine: 1, endLine: 5 },
          { ref: "c.md", grade: 1, startLine: 1, endLine: 5 },
          { ref: "d.md", grade: 1, startLine: 1, endLine: 5 },
        ],
        10,
      );
      const one = scoreQuery(
        [{ ref: "e.md", startLine: 1, endLine: 5 }],
        [{ ref: "e.md", grade: 1, startLine: 1, endLine: 5 }],
        10,
      );
      const result = aggregate([many, one]);
      assert.equal(result.evidenceChecked, 5);
      assert.equal(result.evidenceAccuracy, 3 / 5);
    });

    it("reports evidence accuracy as unmeasurable when no span was pinned", () => {
      const ungraded = [scoreQuery(ranked("a.md"), [{ ref: "a.md", grade: 1 }], 5)];
      assert.equal(aggregate(ungraded).evidenceAccuracy, null);
    });

    it("handles an empty dataset", () => {
      const empty = aggregate([]);
      assert.equal(empty.queries, 0);
      assert.equal(empty.recallAtK, null);
      assert.equal(empty.mrr, null);
    });
  });
});
