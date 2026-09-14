import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_EMBEDDING,
  DEFAULT_RERANK,
  DEFAULT_SEARCH,
  defaultCorpusConfig,
} from "./config.ts";

describe("application/config", () => {
  describe("defaults chosen deliberately", () => {
    it("defaults to the dependency-free embedder, so a fresh install just works", () => {
      assert.equal(DEFAULT_EMBEDDING.provider, "hash");
      assert.equal(DEFAULT_EMBEDDING.model, null);
    });

    it("defaults reranking off, because it costs a model download and real CPU", () => {
      assert.equal(DEFAULT_RERANK.enabled, false);
    });

    it("names a reranker model anyway, so enabling it is a one-line change", () => {
      assert.ok(DEFAULT_RERANK.model.length > 0);
    });

    it("defers the dense floor to the embedding model", () => {
      assert.equal(
        DEFAULT_SEARCH.minDenseSimilarity,
        null,
        "only the model knows what its cosine scale means",
      );
    });

    it("explores further than it searches", () => {
      assert.ok(DEFAULT_SEARCH.exploreHops > DEFAULT_SEARCH.graphHops);
    });

    it("retrieves more candidates than it returns, so fusion has something to fuse", () => {
      assert.ok(DEFAULT_SEARCH.candidateMultiplier > 1);
    });

    it("enables all three signals", () => {
      assert.ok(DEFAULT_SEARCH.enableDense);
      assert.ok(DEFAULT_SEARCH.enableLexical);
      assert.ok(DEFAULT_SEARCH.enableGraph);
    });
  });

  describe("defaultCorpusConfig", () => {
    it("names the corpus and starts with no sources", () => {
      const config = defaultCorpusConfig("docs");
      assert.equal(config.name, "docs");
      assert.deepEqual(config.sources, []);
      assert.equal(config.description, "");
    });

    it("returns an independent object each time", () => {
      const first = defaultCorpusConfig("a");
      const second = defaultCorpusConfig("b");
      assert.notEqual(first.sources, second.sources);
    });
  });
});
