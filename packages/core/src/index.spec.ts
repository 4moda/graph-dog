import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as core from "./index.ts";

/**
 * The public surface of a published package is a contract. Removing an export
 * breaks consumers silently at build time in their repository, not ours, so it
 * is worth pinning here.
 */
describe("core/index", () => {
  it("exports the use cases", () => {
    for (const name of ["buildCorpus", "searchCorpus", "exploreCorpus", "readDocument", "describeCorpus"]) {
      assert.equal(typeof (core as Record<string, unknown>)[name], "function", `missing ${name}`);
    }
  });

  it("exports the composition root, so callers never wire adapters themselves", () => {
    assert.equal(typeof core.openCorpus, "function");
    assert.equal(typeof core.assertCompatible, "function");
  });

  it("exports the workspace helpers the CLI and MCP server both need", () => {
    for (const name of ["resolveCorpus", "readCorpusConfig", "listCorpusNames", "initProjectWorkspace"]) {
      assert.equal(typeof (core as Record<string, unknown>)[name], "function", `missing ${name}`);
    }
  });

  it("exports the DTO mappers, which is what keeps CLI and MCP output identical", () => {
    for (const name of ["toHitDto", "toFreshnessDto", "toWarningDtos", "toLocationDto"]) {
      assert.equal(typeof (core as Record<string, unknown>)[name], "function", `missing ${name}`);
    }
  });

  it("exports the error taxonomy and exit codes", () => {
    assert.equal(typeof core.GraphDogError, "function");
    assert.equal(typeof core.toGraphDogError, "function");
    assert.equal(core.ExitCode.NO_EVIDENCE, 7);
  });

  it("exports the contract versions a consumer gates on", () => {
    assert.ok(core.SCHEMA_VERSION.length > 0);
    assert.ok(core.CONTRACT_VERSION.length > 0);
  });

  it("exports the defaults", () => {
    assert.equal(core.DEFAULT_EMBEDDING.provider, "hash");
    assert.equal(core.DEFAULT_FUSION.strategy, "rrf");
    assert.ok(core.DEFAULT_CHUNKING.maxChars > 0);
  });

  it("does not leak infrastructure adapters, which would bypass the composition root", () => {
    for (const name of ["SqliteCorpusStore", "LocalSourceReader", "HashingEmbeddingModel"]) {
      assert.equal(
        (core as Record<string, unknown>)[name],
        undefined,
        `${name} should stay internal`,
      );
    }
  });

  it("reports a version matching the manifest", () => {
    assert.match(core.VERSION, /^\d+\.\d+\.\d+$/);
  });
});
