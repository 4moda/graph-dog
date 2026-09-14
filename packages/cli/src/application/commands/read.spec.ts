import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RefNotFoundError, UsageError, type ReadResponseDto, type SearchResponseDto } from "@graphdog/core";

import { FIXTURE_DOCS, cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { addSpec, runAdd } from "./add.ts";
import { buildSpec, runBuild } from "./build.ts";
import { initSpec, runInit } from "./init.ts";
import { readSpec, runRead } from "./read.ts";
import { runSearch, searchSpec } from "./search.ts";

async function builtProject(): Promise<string> {
  const root = await makeProject(FIXTURE_DOCS);
  await run(initSpec, runInit, root, ["demo"]);
  await run(addSpec, runAdd, root, ["./docs"]);
  await run(buildSpec, (context) => runBuild(context, true), root, []);
  return root;
}

const read = (cwd: string, argv: readonly string[]) => run(readSpec, runRead, cwd, argv);

describe("cli/application/commands/read", () => {
  it("returns the whole document by default", async () => {
    const root = await builtProject();
    try {
      const response = (await read(root, ["docs/keys.md"])).json as ReadResponseDto;
      assert.match(response.text, /JWKS endpoint/);
      assert.equal(response.truncated, false);
    } finally {
      await cleanup(root);
    }
  });

  it("round-trips a read_ref from a search hit", async () => {
    const root = await builtProject();
    try {
      const search = (await run(searchSpec, (c) => runSearch(c, "search"), root, ["JWKS"]))
        .json as SearchResponseDto;
      const readRef = search.hits[0]?.read_ref ?? "";

      const response = (await read(root, [readRef])).json as ReadResponseDto;
      assert.ok(response.text.length > 0);
      assert.equal(response.ref, "docs/keys.md");
    } finally {
      await cleanup(root);
    }
  });

  it("honours --lines", async () => {
    const root = await builtProject();
    try {
      const response = (await read(root, ["docs/token.md", "--lines", "6-8"])).json as ReadResponseDto;
      assert.equal(response.location.start_line, 6);
      assert.equal(response.location.end_line, 8);
    } finally {
      await cleanup(root);
    }
  });

  it("accepts an open-ended range", async () => {
    const root = await builtProject();
    try {
      const response = (await read(root, ["docs/token.md", "--lines", "10-"])).json as ReadResponseDto;
      assert.equal(response.location.start_line, 10);
      assert.equal(response.location.end_line, response.total_lines);
    } finally {
      await cleanup(root);
    }
  });

  it("accepts a single line", async () => {
    const root = await builtProject();
    try {
      const response = (await read(root, ["docs/token.md", "--lines", "6"])).json as ReadResponseDto;
      assert.equal(response.location.start_line, 6);
      assert.equal(response.location.end_line, 6);
    } finally {
      await cleanup(root);
    }
  });

  it("rejects a malformed range instead of guessing", async () => {
    const root = await builtProject();
    try {
      await assert.rejects(() => read(root, ["docs/token.md", "--lines", "abc"]), UsageError);
    } finally {
      await cleanup(root);
    }
  });

  it("flags truncation rather than shortening silently", async () => {
    const root = await builtProject();
    try {
      const response = (await read(root, ["docs/token.md", "--max-chars", "20"])).json as ReadResponseDto;
      assert.equal(response.truncated, true);
      assert.equal(response.text.length, 20);
      assert.ok(response.warnings.length > 0);
    } finally {
      await cleanup(root);
    }
  });

  it("requires a ref, and points at search", async () => {
    const root = await builtProject();
    try {
      await assert.rejects(
        () => read(root, []),
        (error: unknown) => {
          assert.ok(error instanceof UsageError);
          assert.match(String(error.details["hint"]), /read_ref/);
          return true;
        },
      );
    } finally {
      await cleanup(root);
    }
  });

  it("reports an unknown ref as not found", async () => {
    const root = await builtProject();
    try {
      await assert.rejects(() => read(root, ["docs/nope.md"]), RefNotFoundError);
    } finally {
      await cleanup(root);
    }
  });
});
