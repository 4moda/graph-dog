import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryStore, StubEmbeddingModel } from "../../__fixtures__/in-memory-store.ts";
import { assessFreshness } from "../../domain/model/freshness.ts";
import { defaultCorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { SearchDependencies } from "./search-corpus.ts";
import { searchCorpora, type CorpusTarget } from "./search-corpora.ts";

const BUILT_AT = "2026-09-14T00:00:00.000Z";
const CURRENT = assessFreshness(BUILT_AT, [
  { sourceId: "s", indexedRevision: "abc", currentRevision: "abc" },
]);
const STALE = assessFreshness(BUILT_AT, [
  { sourceId: "s", indexedRevision: "old", currentRevision: "new" },
]);

function corpus(
  name: string,
  documents: Array<{ ref: string; text: string; title?: string }>,
  overrides: Partial<SearchDependencies> = {},
): CorpusTarget {
  const store = new InMemoryStore();
  for (const document of documents) {
    store.addDocument({ ref: document.ref, text: document.text, title: document.title ?? document.ref });
  }
  const base = defaultCorpusConfig(name);
  return {
    name,
    scope: "project",
    dependencies: {
      store,
      config: { ...base, search: { ...base.search, minScore: 0 } },
      embedding: new StubEmbeddingModel(),
      freshness: CURRENT,
      ...overrides,
    },
  };
}

const AUTH = () =>
  corpus("auth", [
    { ref: "auth/tokens.md", text: "Access tokens are JWT values.\n\nJWKS publishes the keys." },
    { ref: "auth/menu.md", text: "Unrelated cafeteria content." },
  ]);

const OPS = () =>
  corpus("ops", [
    { ref: "ops/runbook.md", text: "Rotate the JWKS signing keys quarterly." },
    { ref: "ops/oncall.md", text: "Unrelated rota information." },
  ]);

describe("application/usecase/searchCorpora", () => {
  describe("merging", () => {
    it("returns hits from every corpus that matched", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      const corpora = new Set(result.hits.map((hit) => hit.corpus));
      assert.deepEqual([...corpora].sort(), ["auth", "ops"]);
    });

    it("labels every hit with the corpus it came from", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.ok(result.hits.every((hit) => hit.corpus === "auth" || hit.corpus === "ops"));
    });

    it("records each hit's rank within its own corpus", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      const firsts = result.hits.filter((hit) => hit.corpusRank === 1);
      assert.equal(firsts.length, 2, "each corpus contributes exactly one rank-1 hit");
    });

    it("merges by rank, so a weak corpus cannot promote itself with an inflated score", async () => {
      // Both corpora normalize their own best hit to 1.0. If the merge used
      // those numbers, the corpus with the weaker best hit would tie the
      // stronger one. Rank fusion gives both rank-1 hits the same credit, and
      // everything below ranks beneath them.
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      const topTwo = result.hits.slice(0, 2);
      assert.ok(topTwo.every((hit) => hit.corpusRank === 1), "rank-1 hits should lead");
    });

    it("normalizes the best merged hit to 1", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.equal(result.hits[0]?.scores.final, 1);
    });

    it("preserves each hit's per-signal scores from its own corpus", async () => {
      // Only `final` is replaced by the cross-corpus score; how a hit was found
      // in its own corpus remains true and is still reported.
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.notEqual(result.hits[0]?.scores.bm25, null);
    });

    it("honours a global topK across all corpora", async () => {
      const result = await searchCorpora({ query: "JWKS keys", topK: 1 }, { targets: [AUTH(), OPS()] });
      assert.equal(result.hits.length, 1);
    });

    it("is deterministic across runs", async () => {
      const first = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      const second = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.deepEqual(
        first.hits.map((hit) => [hit.corpus, hit.chunkId, hit.scores.final]),
        second.hits.map((hit) => [hit.corpus, hit.chunkId, hit.scores.final]),
      );
    });

    it("is order-independent: the same corpora in a different order give the same ranking", async () => {
      const forward = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      const reverse = await searchCorpora({ query: "JWKS" }, { targets: [OPS(), AUTH()] });
      assert.deepEqual(
        forward.hits.map((hit) => `${hit.corpus}/${hit.ref}`),
        reverse.hits.map((hit) => `${hit.corpus}/${hit.ref}`),
      );
    });
  });

  describe("reporting", () => {
    it("summarizes every corpus considered", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.deepEqual(result.corpora.map((entry) => entry.name), ["auth", "ops"]);
      assert.ok(result.corpora.every((entry) => entry.searched));
    });

    it("counts how many returned hits each corpus contributed", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      const total = result.corpora.reduce((sum, entry) => sum + entry.hits, 0);
      assert.equal(total, result.hits.length);
    });

    it("names every corpus in the display label", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.equal(result.corpus, "auth, ops");
    });

    it("reports which corpora were searched and how many were skipped", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.equal(result.stats["corpora_searched"], 2);
      assert.equal(result.stats["corpora_skipped"], 0);
    });

    it("interleaves suggestions so one corpus cannot fill the list", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.equal(new Set(result.suggestedQueries).size, result.suggestedQueries.length);
    });
  });

  describe("skipped corpora", () => {
    it("reports an unavailable corpus rather than quietly shrinking the search", async () => {
      const unavailable: CorpusTarget = { ...OPS(), unavailable: "corpus has not been built" };
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), unavailable] });

      const skipped = result.corpora.find((entry) => entry.name === "ops");
      assert.equal(skipped?.searched, false);
      assert.equal(skipped?.skipped_reason, "corpus has not been built");
      assert.ok(result.warnings.some((warning) => warning.code === WarningCode.CORPUS_SKIPPED));
    });

    it("still returns results from the corpora that worked", async () => {
      const unavailable: CorpusTarget = { ...OPS(), unavailable: "incompatible" };
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), unavailable] });
      assert.ok(result.hits.length > 0);
      assert.ok(result.hits.every((hit) => hit.corpus === "auth"));
    });

    it("reports no evidence when every corpus was skipped", async () => {
      const result = await searchCorpora(
        { query: "JWKS" },
        { targets: [{ ...AUTH(), unavailable: "broken" }, { ...OPS(), unavailable: "broken" }] },
      );
      assert.ok(result.noEvidence);
      assert.equal(result.hits.length, 0);
      assert.ok(
        result.warnings.some((warning) => warning.code === WarningCode.NO_SUFFICIENT_EVIDENCE),
      );
    });

    it("survives a corpus whose search throws", async () => {
      const broken = AUTH();
      const throwing: CorpusTarget = {
        ...broken,
        dependencies: {
          ...broken.dependencies,
          get store(): never {
            throw new Error("database is locked");
          },
        } as unknown as SearchDependencies,
      };
      const result = await searchCorpora({ query: "JWKS" }, { targets: [throwing, OPS()] });
      assert.ok(result.hits.length > 0, "the healthy corpus must still answer");
      assert.ok(result.corpora.some((entry) => entry.skipped_reason?.includes("locked")));
    });
  });

  describe("mixed embeddings", () => {
    it("warns when corpora were built with different models", async () => {
      const other = corpus("ops", [{ ref: "ops/runbook.md", text: "Rotate the JWKS keys." }], {
        embedding: Object.assign(new StubEmbeddingModel(), { id: "st:other-model:d384" }),
      });
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), other] });
      const warning = result.warnings.find((w) => w.code === WarningCode.MIXED_EMBEDDINGS);
      assert.ok(warning, "a caller comparing ranks across models should be told");
      assert.equal((warning?.details?.["embeddings"] as string[]).length, 2);
    });

    it("does not warn when every corpus used the same model", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.ok(!result.warnings.some((w) => w.code === WarningCode.MIXED_EMBEDDINGS));
    });
  });

  describe("freshness", () => {
    it("reports the least reassuring status across the corpora", async () => {
      // One stale corpus makes the whole answer possibly stale; reporting
      // `current` on the strength of the others would be misleading.
      const stale = corpus("ops", [{ ref: "ops/r.md", text: "JWKS rotation." }], { freshness: STALE });
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), stale] });
      assert.equal(result.freshness.status, "stale");
    });

    it("reports current when every corpus is current", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), OPS()] });
      assert.equal(result.freshness.status, "current");
    });

    it("carries each corpus's warnings, labelled with its name", async () => {
      const stale = corpus("ops", [{ ref: "ops/r.md", text: "JWKS rotation." }], { freshness: STALE });
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), stale] });
      const staleWarning = result.warnings.find((w) => w.code === WarningCode.STALE_CORPUS);
      assert.match(staleWarning?.message ?? "", /^ops: /);
    });

    it("does not treat one corpus's empty result as an overall miss", async () => {
      const empty = corpus("ops", [{ ref: "ops/x.md", text: "entirely unrelated content" }]);
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), empty] });
      assert.ok(result.hits.length > 0);
      assert.ok(!result.noEvidence);
      assert.ok(
        !result.warnings.some((w) => w.code === WarningCode.NO_SUFFICIENT_EVIDENCE),
        "one quiet corpus is not an overall no-evidence result",
      );
    });
  });

  describe("single corpus", () => {
    it("passes through the single-corpus pipeline unchanged", async () => {
      // With nothing to merge against, re-ranking would flatten the fused
      // scores to reciprocal ranks and lose the per-signal calibration.
      const target = AUTH();
      const result = await searchCorpora({ query: "JWKS" }, { targets: [target] });
      assert.equal(result.corpus, "auth");
      assert.equal(result.corpora.length, 1);
      assert.equal(result.corpora[0]?.scope, "project");
      assert.equal(result.strategy["fusion"], "rrf", "not the cross-corpus strategy");
    });

    it("still reports the refs it found", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH()] });
      assert.ok((result.topRefsByCorpus.get("auth") ?? []).length > 0);
    });
  });

  describe("edge cases", () => {
    it("handles no targets at all", async () => {
      const result = await searchCorpora({ query: "JWKS" }, { targets: [] });
      assert.ok(result.noEvidence);
      assert.equal(result.hits.length, 0);
      assert.equal(result.freshness.status, "unknown");
    });

    it("handles a query that matches nothing anywhere", async () => {
      const result = await searchCorpora(
        { query: "quantum chromodynamics" },
        { targets: [AUTH(), OPS()] },
      );
      assert.ok(result.noEvidence);
      assert.match(String(result.warnings[0]?.message), /any of 2/);
    });
  });
});

describe("application/usecase/searchCorpora: warning hygiene", () => {
  it("collapses an advisory that every corpus repeats into one", async () => {
    // "these corpora use the lexical embedder" is one fact about two corpora,
    // not two facts. Repeating it buries the warnings that actually differ.
    const lexicalEmbedder = () => new StubEmbeddingModel({}, false);
    const result = await searchCorpora(
      { query: "JWKS" },
      {
        targets: [
          { ...AUTH(), dependencies: { ...AUTH().dependencies, embedding: lexicalEmbedder() } },
          { ...OPS(), dependencies: { ...OPS().dependencies, embedding: lexicalEmbedder() } },
        ],
      },
    );
    const lexical = result.warnings.filter((w) => w.code === WarningCode.LEXICAL_EMBEDDING);
    assert.equal(lexical.length, 1);
    assert.match(lexical[0]?.message ?? "", /^auth, ops: /);
    assert.deepEqual(lexical[0]?.details?.["corpora"], ["auth", "ops"]);
  });

  it("keeps a warning that applies to only one corpus attributed to it", async () => {
    const stale = corpus("ops", [{ ref: "ops/r.md", text: "JWKS rotation." }], { freshness: STALE });
    const result = await searchCorpora({ query: "JWKS" }, { targets: [AUTH(), stale] });
    const staleWarnings = result.warnings.filter((w) => w.code === WarningCode.STALE_CORPUS);
    assert.equal(staleWarnings.length, 1);
    assert.match(staleWarnings[0]?.message ?? "", /^ops: /);
    assert.equal(staleWarnings[0]?.details?.["corpus"], "ops");
  });
});
