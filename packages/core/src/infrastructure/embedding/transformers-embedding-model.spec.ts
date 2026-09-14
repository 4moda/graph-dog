import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError } from "../../domain/errors.ts";
import { DEFAULT_MODEL, TransformersEmbeddingModel } from "./transformers-embedding-model.ts";

/**
 * `@huggingface/transformers` is an optional peer dependency, so the behaviour
 * that must hold on a default install is the one tested here: asking for
 * semantic embeddings without it fails with an actionable message rather than a
 * module-resolution stack trace. The model's retrieval quality is a property of
 * the model, not of this adapter.
 */
describe("infrastructure/embedding/transformersEmbeddingModel", () => {
  it("names a multilingual default model", () => {
    assert.match(DEFAULT_MODEL, /e5/, "the default must handle Japanese as well as English");
  });

  it("reports the package to install when the optional dependency is absent", async function () {
    try {
      // Through a variable so tsc does not resolve the optional peer at build time.
      const specifier = "@huggingface/transformers";
      await import(specifier);
      // Installed in this environment: the failure path cannot be exercised.
      return;
    } catch {
      // Not installed, which is the default install and the case under test.
    }

    await assert.rejects(
      () => TransformersEmbeddingModel.load(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /@huggingface\/transformers/);
        assert.match(error.message, /npm install/);
        return true;
      },
    );
  });
});
