import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExitCode, IncompatibleCorpusError, UsageError, type ExploreResponseDto, type SearchResponseDto } from "@graphdog/core";

import { FIXTURE_DOCS, cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { addSpec, runAdd } from "./add.ts";
import { buildSpec, runBuild } from "./build.ts";
import { initSpec, runInit } from "./init.ts";
import { exploreSpec, runSearch, searchSpec } from "./search.ts";

async function builtProject(): Promise<string> {
  const root = await makeProject(FIXTURE_DOCS);
  await run(initSpec, runInit, root, ["demo"]);
  await run(addSpec, runAdd, root, ["./docs"]);
  await run(buildSpec, (context) => runBuild(context, true), root, []);
  return root;
}

const search = (cwd: string, argv: readonly string[]) =>
  run(searchSpec, (context) => runSearch(context, "search"), cwd, argv);
const explore = (cwd: string, argv: readonly string[]) =>
  run(exploreSpec, (context) => runSearch(context, "explore"), cwd, argv);

describe("cli/application/commands/search", () => {
  it("finds a document by keyword", async () => {
    const root = await builtProject();
    try {
      const response = (await search(root, ["JWKS"])).json as SearchResponseDto;
      assert.equal(response.hits[0]?.ref, "docs/keys.md");
    } finally {
      await cleanup(root);
    }
  });

  it("gives each hit a read_ref that read accepts", async () => {
    const root = await builtProject();
    try {
      const response = (await search(root, ["JWKS"])).json as SearchResponseDto;
      assert.match(response.hits[0]?.read_ref ?? "", /^docs\/keys\.md#L\d+/);
    } finally {
      await cleanup(root);
    }
  });

  it("joins multiple positionals into one query", async () => {
    const root = await builtProject();
    try {
      const response = (await search(root, ["access", "token"])).json as SearchResponseDto;
      assert.equal(response.query, "access token");
    } finally {
      await cleanup(root);
    }
  });

  it("exits with the no-evidence code when nothing matches", async () => {
    const root = await builtProject();
    try {
      const result = await search(root, ["quantum", "chromodynamics"]);
      assert.equal(result.exitCode, ExitCode.NO_EVIDENCE);
      assert.equal((result.json as SearchResponseDto).hits.length, 0);
    } finally {
      await cleanup(root);
    }
  });

  it("requires a query", async () => {
    const root = await builtProject();
    try {
      await assert.rejects(() => search(root, []), UsageError);
    } finally {
      await cleanup(root);
    }
  });

  it("honours --top-k", async () => {
    const root = await builtProject();
    try {
      const response = (await search(root, ["token", "keys", "--top-k", "1"])).json as SearchResponseDto;
      assert.equal(response.hits.length, 1);
    } finally {
      await cleanup(root);
    }
  });

  it("rejects a non-numeric --top-k rather than silently returning nothing", async () => {
    const root = await builtProject();
    try {
      await assert.rejects(() => search(root, ["token", "--top-k", "many"]), UsageError);
    } finally {
      await cleanup(root);
    }
  });

  it("disables the graph with --hops 0", async () => {
    const root = await builtProject();
    try {
      const response = (await search(root, ["JWKS", "--hops", "0"])).json as SearchResponseDto;
      assert.equal(response.strategy["graph"], "off");
    } finally {
      await cleanup(root);
    }
  });

  it("filters to a source", async () => {
    const root = await builtProject();
    try {
      const response = (await search(root, ["token", "--source", "docs"])).json as SearchResponseDto;
      assert.ok(response.hits.every((hit) => hit.ref.startsWith("docs/")));
    } finally {
      await cleanup(root);
    }
  });

  it("does not go looking for a reranker the query did not ask for", async () => {
    // Loading a cross-encoder is a model load, and on a fresh machine a
    // download. A corpus that does not rerank by default must not pay for one,
    // so nothing is attempted and nothing is warned about.
    //
    // The other direction -- asked for and unavailable -- is asserted in
    // `search-corpus.spec.ts`, where the reranker can be injected. Asserting it
    // here would depend on whether the optional model happens to be installed
    // on the machine running the tests.
    const root = await builtProject();
    try {
      for (const argv of [["JWKS"], ["JWKS", "--no-rerank"]]) {
        const response = (await search(root, argv)).json as SearchResponseDto;
        assert.ok(response.hits.length > 0);
        assert.equal(response.strategy["rerank"], "off");
        assert.ok(!response.warnings.some((warning) => warning.code === "rerank_unavailable"));
      }
    } finally {
      await cleanup(root);
    }
  });

  it("refuses to search a corpus that was never built", async () => {
    const root = await makeProject(FIXTURE_DOCS);
    try {
      await run(initSpec, runInit, root, ["demo"]);
      await run(addSpec, runAdd, root, ["./docs"]);
      await assert.rejects(() => search(root, ["anything"]), IncompatibleCorpusError);
    } finally {
      await cleanup(root);
    }
  });

  it("reports exactly how the result was produced", async () => {
    const root = await builtProject();
    try {
      const response = (await search(root, ["JWKS"])).json as SearchResponseDto;
      assert.equal(response.strategy["fusion"], "rrf");
      assert.equal(response.strategy["lexical"], "bm25");
      // The default corpus has hashing vectors, but they are not ranked against
      // the query: the strategy says so rather than leaving the caller to guess.
      assert.equal(response.strategy["dense"], "off:lexical-embedder");
    } finally {
      await cleanup(root);
    }
  });
});

describe("cli/application/commands/explore", () => {
  it("returns the graph neighbourhood alongside the hits", async () => {
    const root = await builtProject();
    try {
      const response = (await explore(root, ["JWKS"])).json as ExploreResponseDto;
      assert.equal(response.kind, "explore");
      assert.ok(response.nodes.length > 0);
      assert.ok(response.edges.length > 0);
    } finally {
      await cleanup(root);
    }
  });

  it("uses a wider hop budget than search", async () => {
    const root = await builtProject();
    try {
      const response = (await explore(root, ["JWKS"])).json as ExploreResponseDto;
      assert.match(String(response.strategy["graph"]), /3hop/);
    } finally {
      await cleanup(root);
    }
  });

  it("agrees with search about the top result", async () => {
    const root = await builtProject();
    try {
      const searched = (await search(root, ["JWKS"])).json as SearchResponseDto;
      const explored = (await explore(root, ["JWKS"])).json as ExploreResponseDto;
      assert.equal(explored.hits[0]?.ref, searched.hits[0]?.ref);
    } finally {
      await cleanup(root);
    }
  });
});
