import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../domain/errors.ts";
import { DEFAULT_RERANK_MODEL, TransformersReranker } from "./transformers-reranker.ts";

/**
 * As with the embedding adapter, the behaviour that matters on a default
 * install is the failure path: reranking is optional, and asking for it without
 * the dependency must say so clearly. Search then degrades to fusion order and
 * attaches a warning rather than failing the query.
 */
describe("infrastructure/rerank/transformersReranker", () => {
  it("names a cross-encoder default that is configurable", () => {
    assert.ok(DEFAULT_RERANK_MODEL.includes("/"), "should be a Hub model id");
  });

  it("reports the package to install when the optional dependency is absent", async () => {
    try {
      // Through a variable so tsc does not resolve the optional peer at build time.
      const specifier = "@huggingface/transformers";
      await import(specifier);
      return;
    } catch {
      // Not installed: the default install, and the case under test.
    }

    await assert.rejects(
      () => TransformersReranker.load(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /@huggingface\/transformers/);
        return true;
      },
    );
  });
});
