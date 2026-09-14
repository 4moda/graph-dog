import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryStore, StubEmbeddingModel } from "../../__fixtures__/in-memory-store.ts";
import { assessFreshness } from "../../domain/model/freshness.ts";
import { defaultCorpusConfig, type CorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { EvalDataset } from "../../infrastructure/config/eval-dataset.ts";
import type { SearchDependencies } from "./search-corpus.ts";
import { DEFAULT_EVAL_K, evaluateCorpus } from "./evaluate-corpus.ts";

const CURRENT = assessFreshness("2026-09-14T00:00:00.000Z", [
  { sourceId: "docs", indexedRevision: "abc", currentRevision: "abc" },
]);

function config(): CorpusConfig {
  const base = defaultCorpusConfig("test-corpus");
  return { ...base, search: { ...base.search, minScore: 0 } };
}

function populatedStore(): InMemoryStore {
  const store = new InMemoryStore();
  store.addDocument({
    ref: "docs/token.md",
    title: "Access Token",
    text: "Access tokens are signed JWT values.\n\nRotation happens every hour.",
  });
  store.addDocument({
    ref: "docs/keys.md",
    title: "Key Management",
    text: "JWKS endpoints publish the public keys.",
  });
  store.addDocument({
    ref: "docs/unrelated.md",
    title: "Cafeteria Menu",
    text: "Lunch is served between twelve and two.",
  });
  return store;
}

function deps(
  store: InMemoryStore = populatedStore(),
  overrides: Partial<SearchDependencies> = {},
): SearchDependencies {
  return {
    store,
    config: config(),
    embedding: new StubEmbeddingModel(),
    freshness: CURRENT,
    ...overrides,
  };
}

function dataset(overrides: Partial<EvalDataset> = {}): EvalDataset {
  return {
    name: "auth",
    corpus: "test-corpus",
    description: "",
    queries: [
      { id: "jwks", query: "JWKS", judgments: [{ ref: "docs/keys.md", grade: 3 }], note: null },
    ],
    ...overrides,
  };
}

describe("application/usecase/evaluateCorpus", () => {
  describe("running the real pipeline", () => {
    it("scores a query whose answer the search finds", async () => {
      const report = await evaluateCorpus({ dataset: dataset() }, deps());
      assert.equal(report.summary.recallAtK, 1);
      assert.equal(report.summary.mrr, 1);
      assert.equal(report.queries[0]?.metrics.reciprocalRank, 1);
    });

    it("scores a query whose answer the search misses", async () => {
      const missing = dataset({
        queries: [
          {
            id: "lunch",
            query: "JWKS",
            judgments: [{ ref: "docs/unrelated.md", grade: 1 }],
            note: null,
          },
        ],
      });
      const report = await evaluateCorpus({ dataset: missing }, deps());
      assert.equal(report.summary.recallAtK, 0);
      assert.equal(report.summary.missedQueries, 1);
      assert.deepEqual(report.queries[0]?.missingRefs, ["docs/unrelated.md"]);
    });

    it("reports the refs it actually returned, so a regression is diffable", async () => {
      const report = await evaluateCorpus({ dataset: dataset() }, deps());
      assert.deepEqual(report.queries[0]?.retrievedRefs, ["docs/keys.md"]);
    });

    it("deduplicates a document that matched through several chunks", async () => {
      const store = new InMemoryStore();
      store.addDocument({
        ref: "docs/rotation.md",
        text: "Rotation of keys.\n\nRotation of keys again.\n\nRotation of keys once more.",
      });
      const report = await evaluateCorpus(
        {
          dataset: dataset({
            queries: [
              { id: "rot", query: "rotation", judgments: [{ ref: "docs/rotation.md", grade: 1 }], note: null },
            ],
          }),
        },
        deps(store),
      );
      assert.deepEqual(report.queries[0]?.retrievedRefs, ["docs/rotation.md"]);
      assert.equal(report.queries[0]?.metrics.retrieved, 1, "three chunks are one document");
    });

    it("carries the query's note into the report", async () => {
      const noted = dataset({
        queries: [{ id: "jwks", query: "JWKS", judgments: [], note: "paraphrase check" }],
      });
      const report = await evaluateCorpus({ dataset: noted }, deps());
      assert.equal(report.queries[0]?.note, "paraphrase check");
    });

    it("records the strategy the run measured, so a stored report is self-describing", async () => {
      const report = await evaluateCorpus({ dataset: dataset() }, deps());
      assert.equal(report.strategy["lexical"], "bm25");
      assert.equal(report.strategy["top_k"], DEFAULT_EVAL_K);
    });

    it("names the corpus and the embedding that produced the numbers", async () => {
      const report = await evaluateCorpus({ dataset: dataset() }, deps());
      assert.equal(report.corpus, "test-corpus");
      assert.equal(report.embeddingId, "stub:v1:d3");
      assert.equal(report.dataset, "auth");
    });
  });

  describe("options", () => {
    it("uses k as both the cutoff and the number of hits requested", async () => {
      const report = await evaluateCorpus({ dataset: dataset(), k: 2 }, deps());
      assert.equal(report.k, 2);
      assert.equal(report.strategy["top_k"], 2);
    });

    it("passes minScore through, so one setting can be measured at a time", async () => {
      const report = await evaluateCorpus({ dataset: dataset(), minScore: 0.99 }, deps());
      assert.equal(report.strategy["min_score"], 0.99);
    });

    it("counts a query that cleared nothing as a zero-result query", async () => {
      // Fusion normalizes the best hit to 1.0, so only a threshold above 1 can
      // reject every result; that is what makes this an empty run rather than
      // an unlucky one.
      const report = await evaluateCorpus({ dataset: dataset(), minScore: 1.5 }, deps());
      assert.equal(report.summary.zeroResultQueries, 1);
      assert.equal(report.summary.recallAtK, 0);
    });

    it("defaults k to DEFAULT_EVAL_K", async () => {
      const report = await evaluateCorpus({ dataset: dataset() }, deps());
      assert.equal(report.k, DEFAULT_EVAL_K);
    });
  });

  describe("queries that fail", () => {
    it("records the failure and keeps going, rather than losing the whole run", async () => {
      const store = populatedStore();
      const broken = deps(store, {
        embedding: new StubEmbeddingModel(),
        config: { ...config(), search: { ...config().search, enableLexical: true } },
      });
      // Make the second of three queries throw, by breaking the store mid-run.
      let calls = 0;
      const original = store.lexical.postingsFor.bind(store.lexical);
      store.lexical.postingsFor = (terms: readonly string[]) => {
        calls += 1;
        if (calls === 2) throw new Error("index corrupted");
        return original(terms);
      };

      const three = dataset({
        queries: [
          { id: "a", query: "JWKS", judgments: [{ ref: "docs/keys.md", grade: 1 }], note: null },
          { id: "b", query: "tokens", judgments: [{ ref: "docs/token.md", grade: 1 }], note: null },
          { id: "c", query: "lunch", judgments: [{ ref: "docs/unrelated.md", grade: 1 }], note: null },
        ],
      });

      const report = await evaluateCorpus({ dataset: three }, broken);
      assert.equal(report.queries.length, 3);
      assert.equal(report.failedQueries, 1);
      assert.match(report.queries[1]?.error ?? "", /index corrupted/);
      assert.equal(report.queries[2]?.error, null, "the run continued past the failure");
      assert.ok(report.warnings.some((warning) => warning.code === WarningCode.EVAL_QUERY_FAILED));
    });

    it("scores a failed query as a miss rather than skipping it", async () => {
      const store = populatedStore();
      store.lexical.postingsFor = () => {
        throw new Error("boom");
      };
      const report = await evaluateCorpus({ dataset: dataset() }, deps(store));
      assert.equal(report.queries[0]?.metrics.reciprocalRank, 0);
      assert.equal(report.summary.recallAtK, 0);
    });
  });

  describe("unmeasurable datasets", () => {
    it("reports null rather than zero when no query carries judgments", async () => {
      const unjudged = dataset({
        queries: [{ id: "smoke", query: "JWKS", judgments: [], note: null }],
      });
      const report = await evaluateCorpus({ dataset: unjudged }, deps());
      assert.equal(report.summary.recallAtK, null);
      assert.equal(report.summary.measured, 0);
      assert.equal(report.summary.queries, 1, "it still ran, and still cost latency");
    });

    it("warns about judged refs the corpus does not contain", async () => {
      const stale = dataset({
        queries: [
          { id: "gone", query: "JWKS", judgments: [{ ref: "docs/renamed.md", grade: 2 }], note: null },
        ],
      });
      const report = await evaluateCorpus({ dataset: stale }, deps());
      const warning = report.warnings.find((entry) => entry.code === WarningCode.EVAL_UNKNOWN_REF);
      assert.ok(warning, "a typo'd ref reads as a retrieval failure unless it is named");
      assert.deepEqual(warning?.details?.["refs"], ["docs/renamed.md"]);
    });

    it("does not warn when every judged ref exists", async () => {
      const report = await evaluateCorpus({ dataset: dataset() }, deps());
      assert.ok(!report.warnings.some((entry) => entry.code === WarningCode.EVAL_UNKNOWN_REF));
    });

    it("stays quiet about unknown refs when the corpus is empty", async () => {
      // An empty corpus is a build problem, not a dataset problem; blaming the
      // dataset for every ref would bury the real cause.
      const report = await evaluateCorpus({ dataset: dataset() }, deps(new InMemoryStore()));
      assert.ok(!report.warnings.some((entry) => entry.code === WarningCode.EVAL_UNKNOWN_REF));
    });
  });

  describe("evidence spans", () => {
    it("counts a hit on the expected lines as correct", async () => {
      const spanned = dataset({
        queries: [
          {
            id: "jwks",
            query: "JWKS",
            judgments: [{ ref: "docs/keys.md", grade: 3, startLine: 1, endLine: 1 }],
            note: null,
          },
        ],
      });
      const report = await evaluateCorpus({ dataset: spanned }, deps());
      assert.equal(report.summary.evidenceChecked, 1);
      assert.equal(report.summary.evidenceAccuracy, 1);
    });

    it("counts a hit on the wrong lines as incorrect, even though the ref matched", async () => {
      const spanned = dataset({
        queries: [
          {
            id: "jwks",
            query: "JWKS",
            judgments: [{ ref: "docs/keys.md", grade: 3, startLine: 900, endLine: 910 }],
            note: null,
          },
        ],
      });
      const report = await evaluateCorpus({ dataset: spanned }, deps());
      assert.equal(report.summary.recallAtK, 1, "the document was found");
      assert.equal(report.summary.evidenceAccuracy, 0, "but the citation does not check out");
    });
  });

  describe("latency", () => {
    it("reports mean, median, p95 and max in milliseconds", async () => {
      const report = await evaluateCorpus({ dataset: dataset() }, deps());
      assert.ok((report.latency.meanMs ?? -1) >= 0);
      assert.ok((report.latency.p50Ms ?? -1) >= 0);
      assert.ok((report.latency.p95Ms ?? -1) >= 0);
      assert.ok((report.latency.maxMs ?? -1) >= 0);
    });

    it("never reports a max below the median", async () => {
      const many = dataset({
        queries: ["JWKS", "tokens", "rotation", "lunch"].map((query, index) => ({
          id: `q${index}`,
          query,
          judgments: [],
          note: null,
        })),
      });
      const report = await evaluateCorpus({ dataset: many }, deps());
      assert.ok((report.latency.maxMs ?? 0) >= (report.latency.p50Ms ?? 0));
    });
  });

  describe("gates", () => {
    it("passes with no baseline and no thresholds", async () => {
      const report = await evaluateCorpus({ dataset: dataset() }, deps());
      assert.equal(report.passed, true);
      assert.deepEqual(report.gateFailures, []);
      assert.equal(report.comparison, null);
    });

    it("fails when a threshold is not met", async () => {
      const missing = dataset({
        queries: [
          { id: "lunch", query: "JWKS", judgments: [{ ref: "docs/unrelated.md", grade: 1 }], note: null },
        ],
      });
      const report = await evaluateCorpus(
        { dataset: missing, thresholds: new Map([["recall", 0.5]] as const) },
        deps(),
      );
      assert.equal(report.passed, false);
      assert.equal(report.gateFailures[0]?.metric, "recall");
    });

    it("compares against a baseline and reports every metric's delta", async () => {
      const report = await evaluateCorpus(
        {
          dataset: dataset(),
          baseline: { recall: 1, precision: 0.1, mrr: 1, ndcg: 1, evidence: null },
        },
        deps(),
      );
      assert.equal(report.comparison?.length, 5);
      assert.equal(report.comparison?.find((delta) => delta.metric === "recall")?.delta, 0);
      assert.equal(report.passed, true);
    });

    it("fails when a metric fell below its baseline", async () => {
      const missing = dataset({
        queries: [
          { id: "lunch", query: "JWKS", judgments: [{ ref: "docs/unrelated.md", grade: 1 }], note: null },
        ],
      });
      const report = await evaluateCorpus(
        {
          dataset: missing,
          baseline: { recall: 1, precision: 1, mrr: 1, ndcg: 1, evidence: null },
        },
        deps(),
      );
      assert.equal(report.passed, false);
      assert.ok(report.gateFailures.every((failure) => failure.kind === "regression"));
    });

    it("honours a custom tolerance", async () => {
      const report = await evaluateCorpus(
        {
          dataset: dataset(),
          baseline: { recall: 1, precision: 1, mrr: 1, ndcg: 1, evidence: null },
          tolerance: 1,
        },
        deps(),
      );
      assert.equal(report.passed, true, "a tolerance of 1 forgives any drop");
    });
  });
});
