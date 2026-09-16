import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryStore, StubEmbeddingModel } from "../../__fixtures__/in-memory-store.ts";
import { assessFreshness } from "../../domain/model/freshness.ts";
import { documentNodeId } from "../../domain/model/graph.ts";
import { defaultCorpusConfig, type CorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { Reranker } from "../ports/models.ts";
import { searchCorpus, type SearchDependencies } from "./search-corpus.ts";

const BUILT_AT = "2026-09-14T00:00:00.000Z";
const CURRENT = assessFreshness(BUILT_AT, [
  { sourceId: "docs", indexedRevision: "abc", currentRevision: "abc" },
]);

function config(overrides: Partial<CorpusConfig> = {}): CorpusConfig {
  const base = defaultCorpusConfig("test-corpus");
  return {
    ...base,
    search: { ...base.search, minScore: 0, ...(overrides.search ?? {}) },
    ...overrides,
  };
}

function populatedStore(): InMemoryStore {
  const store = new InMemoryStore();
  store.addDocument({
    ref: "docs/token.md",
    title: "Access Token",
    tags: ["auth"],
    revision: "abc",
    text: "Access tokens are signed JWT values.\n\nRotation happens every hour.",
  });
  store.addDocument({
    ref: "docs/keys.md",
    title: "Key Management",
    tags: ["auth"],
    revision: "abc",
    text: "JWKS endpoints publish the public keys.",
  });
  store.addDocument({
    ref: "docs/unrelated.md",
    title: "Cafeteria Menu",
    revision: "abc",
    text: "Lunch is served between twelve and two.",
  });
  return store;
}

function deps(store: InMemoryStore, overrides: Partial<SearchDependencies> = {}): SearchDependencies {
  return {
    store,
    config: config(),
    embedding: new StubEmbeddingModel(),
    freshness: CURRENT,
    ...overrides,
  };
}

describe("application/usecase/searchCorpus", () => {
  describe("lexical retrieval", () => {
    it("finds a document by an exact keyword", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.equal(result.hits[0]?.ref, "docs/keys.md");
    });

    it("does not return unrelated documents", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.ok(!result.hits.some((hit) => hit.ref === "docs/unrelated.md"));
    });

    it("reports bm25 as having run and dense as not, when there are no vectors", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.notEqual(result.hits[0]?.scores.bm25, null);
      assert.equal(result.hits[0]?.scores.dense, null, "no vectors indexed means dense did not run");
      assert.equal(result.strategy["dense"], "off");
    });

    it("attaches a re-readable location to every hit", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      const hit = result.hits[0];
      assert.ok(hit);
      assert.ok(hit.location.startLine >= 1);
      assert.ok(hit.location.endChar > hit.location.startChar);
    });

    it("carries the source revision so a citation can be pinned to a commit", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.equal(result.hits[0]?.sourceRevision, "abc");
    });

    it("finds Japanese text through the shared tokenizer", async () => {
      const store = new InMemoryStore();
      store.addDocument({ ref: "docs/ja.md", text: "アクセストークンの設計方針について" });
      store.addDocument({ ref: "docs/other.md", text: "食堂のメニュー" });
      const result = await searchCorpus({ query: "トークン" }, deps(store));
      assert.equal(result.hits[0]?.ref, "docs/ja.md");
    });
  });

  describe("no evidence", () => {
    it("returns no hits and flags it rather than returning the least-bad row", async () => {
      const result = await searchCorpus({ query: "quantum chromodynamics" }, deps(populatedStore()));
      assert.equal(result.hits.length, 0);
      assert.ok(result.noEvidence);
      assert.ok(result.warnings.some((w) => w.code === WarningCode.NO_SUFFICIENT_EVIDENCE));
    });

    it("drops results below the relevance threshold", async () => {
      const store = populatedStore();
      const strict = deps(store, { config: config({ search: { ...config().search, minScore: 0.99 } }) });
      const result = await searchCorpus({ query: "tokens keys lunch" }, strict);
      assert.ok(result.noEvidence || result.hits.every((hit) => hit.scores.final >= 0.99));
    });

    it("says how many candidates it considered, so the threshold can be tuned", async () => {
      const store = populatedStore();
      const strict = deps(store, { config: config({ search: { ...config().search, minScore: 1.5 } }) });
      const result = await searchCorpus({ query: "JWKS" }, strict);
      const warning = result.warnings.find((w) => w.code === WarningCode.NO_SUFFICIENT_EVIDENCE);
      assert.ok((warning?.details?.["candidates_considered"] as number) > 0);
    });

    it("handles an empty corpus without throwing", async () => {
      const result = await searchCorpus({ query: "anything" }, deps(new InMemoryStore()));
      assert.equal(result.hits.length, 0);
      assert.ok(result.noEvidence);
    });

    it("handles a query with no index terms", async () => {
      const result = await searchCorpus({ query: "!!! ???" }, deps(populatedStore()));
      assert.ok(result.noEvidence);
    });
  });

  describe("dense retrieval", () => {
    it("fuses dense and lexical signals, ranking a both-signal match first", async () => {
      const store = new InMemoryStore();
      store.addDocument({
        ref: "docs/both.md",
        text: "token material",
        vectorsByChunk: { "docs/both.md#0": [1, 0, 0] },
      });
      store.addDocument({
        ref: "docs/denseOnly.md",
        text: "completely different wording",
        vectorsByChunk: { "docs/denseOnly.md#0": [0.9, 0.1, 0] },
      });
      store.addDocument({ ref: "docs/lexicalOnly.md", text: "token elsewhere entirely" });

      const embedding = new StubEmbeddingModel({ token: [1, 0, 0] });
      const result = await searchCorpus({ query: "token" }, deps(store, { embedding }));
      assert.equal(result.hits[0]?.ref, "docs/both.md");
      assert.notEqual(result.hits[0]?.scores.dense, null);
      assert.notEqual(result.hits[0]?.scores.bm25, null);
    });

    it("reports the embedding identity in the strategy", async () => {
      const store = new InMemoryStore();
      store.addDocument({
        ref: "docs/a.md",
        text: "content",
        vectorsByChunk: { "docs/a.md#0": [1, 0, 0] },
      });
      const result = await searchCorpus({ query: "content" }, deps(store));
      assert.equal(result.strategy["dense"], "stub:v1:d3");
    });

    it("does not rank a non-semantic embedder's vectors against the query", async () => {
      // Hashed vectors are the words BM25 already weighs. Fusing them in is one
      // signal voting twice; the vectors stay indexed for the graph's
      // similarity edges, which is what they are actually good for.
      const store = new InMemoryStore();
      store.addDocument({
        ref: "docs/a.md",
        text: "content",
        vectorsByChunk: { "docs/a.md#0": [1, 0, 0] },
      });
      const embedding = new StubEmbeddingModel({ content: [1, 0, 0] }, false);
      const result = await searchCorpus({ query: "content" }, deps(store, { embedding }));

      assert.equal(result.strategy["dense"], "off:lexical-embedder", "and it says why, not just 'off'");
      assert.equal(result.stats["dense_candidates"], 0);
      assert.equal(result.hits[0]?.scores.dense, null);
      assert.ok(result.hits.length > 0, "BM25 still answers the query");
      assert.equal(store.vectors.size(), 1, "the vectors are still there for the graph");
    });
  });

  describe("graph expansion", () => {
    function linkedStore(): InMemoryStore {
      const store = populatedStore();
      store.graph.replaceAll(
        [
          { id: documentNodeId("docs/keys.md"), kind: "document", label: "Key Management", ref: "docs/keys.md" },
          { id: documentNodeId("docs/token.md"), kind: "document", label: "Access Token", ref: "docs/token.md" },
        ],
        [
          {
            src: documentNodeId("docs/keys.md"),
            dst: documentNodeId("docs/token.md"),
            kind: "links_to",
            weight: 1,
          },
        ],
      );
      return store;
    }

    it("surfaces a neighbour of a direct hit", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(linkedStore()));
      assert.ok(result.hits.some((hit) => hit.ref === "docs/token.md"), "graph neighbour missing");
    });

    it("records the edge chain that reached a graph hit", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(linkedStore()));
      const viaGraph = result.hits.find((hit) => hit.ref === "docs/token.md");
      assert.equal(viaGraph?.graphPath[0]?.kind, "links_to");
    });

    it("still ranks the direct match first", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(linkedStore()));
      assert.equal(result.hits[0]?.ref, "docs/keys.md");
    });

    it("can be switched off per query", async () => {
      const result = await searchCorpus({ query: "JWKS", hops: 0 }, deps(linkedStore()));
      assert.ok(!result.hits.some((hit) => hit.ref === "docs/token.md"));
      assert.equal(result.strategy["graph"], "off");
    });

    it("contributes one candidate per reached document, not one per chunk", async () => {
      // The graph's claim is about a document. Spreading it over every chunk
      // turns one claim into a block of tied candidates that RRF then orders by
      // chunk id, which is enough to outrank real textual evidence.
      const store = new InMemoryStore();
      store.addDocument({ ref: "docs/keys.md", text: "JWKS endpoints publish the public keys." });
      store.addDocument({
        ref: "docs/long.md",
        text: Array.from({ length: 12 }, (_, index) => `Paragraph ${index} about nothing.`).join("\n\n"),
      });
      store.graph.replaceAll(
        [
          { id: documentNodeId("docs/keys.md"), kind: "document", label: "Keys", ref: "docs/keys.md" },
          { id: documentNodeId("docs/long.md"), kind: "document", label: "Long", ref: "docs/long.md" },
        ],
        [
          {
            src: documentNodeId("docs/keys.md"),
            dst: documentNodeId("docs/long.md"),
            kind: "links_to",
            weight: 1,
          },
        ],
      );

      const result = await searchCorpus({ query: "JWKS", topK: 20 }, deps(store));
      const fromLong = result.hits.filter((hit) => hit.ref === "docs/long.md");
      assert.equal(fromLong.length, 1, "twelve chunks of one neighbour is one graph claim");
      assert.ok(
        (result.stats["graph_candidates"] as number) <= 2,
        "at most one graph candidate per document, not one per chunk",
      );
    });

    it("lets the graph amplify the chunk that already had the best direct evidence", async () => {
      const store = new InMemoryStore();
      store.addDocument({ ref: "docs/seed.md", text: "JWKS endpoint." });
      store.addDocument({
        ref: "docs/target.md",
        text: "Nothing to see here.\n\nThe JWKS rotation schedule lives here.",
      });
      store.graph.replaceAll(
        [
          { id: documentNodeId("docs/seed.md"), kind: "document", label: "Seed", ref: "docs/seed.md" },
          { id: documentNodeId("docs/target.md"), kind: "document", label: "Target", ref: "docs/target.md" },
        ],
        [
          {
            src: documentNodeId("docs/seed.md"),
            dst: documentNodeId("docs/target.md"),
            kind: "links_to",
            weight: 1,
          },
        ],
      );

      const result = await searchCorpus({ query: "JWKS rotation", topK: 20 }, deps(store));
      const target = result.hits.find((hit) => hit.ref === "docs/target.md");
      assert.ok(target);
      assert.match(target.snippet, /rotation schedule/, "the matching chunk represents the document");
    });
  });

  describe("reranking", () => {
    const reverseReranker: Reranker = {
      id: "test:reverse",
      rerank: async (_query, candidates) =>
        candidates.map((candidate, index) => ({ id: candidate.id, score: index })),
    };

    it("reorders results using the cross-encoder", async () => {
      const store = populatedStore();
      const base = await searchCorpus({ query: "JWKS tokens" }, deps(store));
      const reranked = await searchCorpus(
        { query: "JWKS tokens", rerank: true },
        deps(store, { reranker: reverseReranker }),
      );
      assert.ok(base.hits.length > 1, "need at least two hits to observe reordering");
      assert.notDeepEqual(
        reranked.hits.map((hit) => hit.ref),
        base.hits.map((hit) => hit.ref),
      );
    });

    it("records the rerank score on each hit it scored", async () => {
      const result = await searchCorpus(
        { query: "JWKS tokens", rerank: true },
        deps(populatedStore(), { reranker: reverseReranker }),
      );
      assert.notEqual(result.hits[0]?.scores.rerank, null);
    });

    it("leaves rerank null when reranking did not run", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.equal(result.hits[0]?.scores.rerank, null);
      assert.equal(result.strategy["rerank"], "off");
    });

    it("warns rather than failing when a reranker was asked for but is absent", async () => {
      const result = await searchCorpus(
        { query: "JWKS", rerank: true },
        deps(populatedStore(), { reranker: null }),
      );
      assert.ok(result.hits.length > 0, "search must still return results");
      assert.ok(result.warnings.some((w) => w.code === WarningCode.RERANK_UNAVAILABLE));
    });

    it("falls back to fusion order when the reranker throws", async () => {
      const broken: Reranker = {
        id: "test:broken",
        rerank: async () => {
          throw new Error("model load failed");
        },
      };
      const result = await searchCorpus(
        { query: "JWKS", rerank: true },
        deps(populatedStore(), { reranker: broken }),
      );
      assert.ok(result.hits.length > 0);
      const warning = result.warnings.find((w) => w.code === WarningCode.RERANK_UNAVAILABLE);
      assert.match(warning?.message ?? "", /model load failed/);
    });
  });

  describe("warnings", () => {
    it("flags a stale corpus without refusing to answer", async () => {
      const stale = assessFreshness(BUILT_AT, [
        { sourceId: "docs", indexedRevision: "old", currentRevision: "new" },
      ]);
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore(), { freshness: stale }));
      assert.ok(result.hits.length > 0, "staleness must not block results");
      assert.ok(result.warnings.some((w) => w.code === WarningCode.STALE_CORPUS));
    });

    it("says when the corpus uses the non-semantic built-in embedder", async () => {
      const lexicalOnly = new StubEmbeddingModel({}, false);
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore(), { embedding: lexicalOnly }));
      assert.ok(result.warnings.some((w) => w.code === WarningCode.LEXICAL_EMBEDDING));
    });

    it("warns that results may be incomplete when files failed to index", async () => {
      const store = populatedStore();
      store.meta.recordFailure({
        ref: "docs/broken.pdf",
        stage: "extract",
        code: "extraction_failed",
        message: "no text layer",
        at: BUILT_AT,
      });
      const result = await searchCorpus({ query: "JWKS" }, deps(store));
      assert.ok(result.warnings.some((w) => w.code === WarningCode.PARTIAL_INDEX));
    });
  });

  describe("options", () => {
    it("honours topK", async () => {
      const result = await searchCorpus({ query: "tokens keys lunch", topK: 1 }, deps(populatedStore()));
      assert.equal(result.hits.length, 1);
    });

    it("filters to a ref prefix", async () => {
      const store = populatedStore();
      store.addDocument({ ref: "other/token.md", text: "Access tokens live here too." });
      const result = await searchCorpus(
        { query: "tokens", filterPrefixes: ["other/"] },
        deps(store),
      );
      assert.ok(result.hits.length > 0);
      assert.ok(result.hits.every((hit) => hit.ref.startsWith("other/")));
    });
  });

  describe("reporting", () => {
    it("reports the strategy actually used", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.equal(result.strategy["fusion"], "rrf");
      assert.equal(result.strategy["lexical"], "bm25");
    });

    it("reports candidate counts so recall problems are diagnosable", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.ok((result.stats["lexical_candidates"] as number) > 0);
      assert.equal(result.stats["corpus_documents"], 3);
    });

    it("suggests follow-up queries drawn from the corpus itself", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.ok(result.suggestedQueries.includes("auth"), result.suggestedQueries.join(","));
    });

    it("does not suggest the query that was just asked", async () => {
      const result = await searchCorpus({ query: "auth" }, deps(populatedStore()));
      assert.ok(!result.suggestedQueries.includes("auth"));
    });

    it("lists the refs of its hits for explore to expand", async () => {
      const result = await searchCorpus({ query: "JWKS" }, deps(populatedStore()));
      assert.deepEqual(result.topRefs, ["docs/keys.md"]);
    });
  });

  describe("determinism", () => {
    it("returns the same ranking for the same query", async () => {
      const store = populatedStore();
      const first = await searchCorpus({ query: "tokens keys" }, deps(store));
      const second = await searchCorpus({ query: "tokens keys" }, deps(store));
      assert.deepEqual(
        first.hits.map((hit) => [hit.chunkId, hit.scores.final]),
        second.hits.map((hit) => [hit.chunkId, hit.scores.final]),
      );
    });
  });
});

describe("application/usecase/searchCorpus: relevance floor", () => {
  /**
   * Regression: dense search returns the top-k by similarity however low it is,
   * so on a small corpus every chunk came back and rank-based fusion handed
   * unrelated documents a plausible-looking score.
   */
  it("does not return a document that resembles nothing in the query", async () => {
    const store = new InMemoryStore();
    store.addDocument({
      ref: "docs/match.md",
      text: "JWKS endpoint publishes keys",
      vectorsByChunk: { "docs/match.md#0": [1, 0, 0] },
    });
    store.addDocument({
      ref: "docs/unrelated.md",
      text: "cafeteria lunch menu",
      vectorsByChunk: { "docs/unrelated.md#0": [0, 1, 0] },
    });

    const embedding = new StubEmbeddingModel({ JWKS: [1, 0, 0] });
    const result = await searchCorpus({ query: "JWKS" }, deps(store, { embedding }));

    assert.deepEqual(result.hits.map((hit) => hit.ref), ["docs/match.md"]);
  });

  it("keeps a candidate whose similarity clears the floor", async () => {
    const store = new InMemoryStore();
    store.addDocument({
      ref: "docs/near.md",
      text: "closely related wording",
      vectorsByChunk: { "docs/near.md#0": [0.9, 0.44, 0] },
    });
    const embedding = new StubEmbeddingModel({ query: [1, 0, 0] });
    const result = await searchCorpus({ query: "query" }, deps(store, { embedding }));
    assert.equal(result.hits.length, 1);
  });

  it("still returns an exact lexical match the embedder scores at zero", async () => {
    const store = new InMemoryStore();
    store.addDocument({
      ref: "docs/exact.md",
      text: "DelegationCode is issued here",
      vectorsByChunk: { "docs/exact.md#0": [0, 1, 0] },
    });
    const embedding = new StubEmbeddingModel({ DelegationCode: [1, 0, 0] });
    const result = await searchCorpus({ query: "DelegationCode" }, deps(store, { embedding }));
    assert.equal(result.hits[0]?.ref, "docs/exact.md", "BM25 must survive the dense floor");
  });
});
