import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CorpusInfoDto, CorpusListDto } from "@graphdog/core";

import { FIXTURE_DOCS, cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { addSpec, runAdd } from "./add.ts";
import { buildSpec, runBuild } from "./build.ts";
import { initSpec, runInit } from "./init.ts";
import { listSpec, runList, runStatus, statusSpec } from "./status.ts";

const originalHome = process.env["GRAPHDOG_HOME"];

async function builtProject(): Promise<string> {
  const root = await makeProject(FIXTURE_DOCS);
  // Isolate from any real home workspace on the machine running the tests.
  process.env["GRAPHDOG_HOME"] = `${root}/fake-home`;
  await run(initSpec, runInit, root, ["demo"]);
  await run(addSpec, runAdd, root, ["./docs"]);
  await run(buildSpec, (context) => runBuild(context, true), root, []);
  return root;
}

async function done(root: string): Promise<void> {
  if (originalHome === undefined) delete process.env["GRAPHDOG_HOME"];
  else process.env["GRAPHDOG_HOME"] = originalHome;
  await cleanup(root);
}

const status = (cwd: string) => run(statusSpec, runStatus, cwd, []);
const list = (cwd: string) => run(listSpec, runList, cwd, []);

describe("cli/application/commands/status", () => {
  it("reports what the corpus contains", async () => {
    const root = await builtProject();
    try {
      const info = (await status(root)).json as CorpusInfoDto;
      assert.equal(info.counts["documents"], 2);
      assert.ok((info.counts["chunks"] ?? 0) > 0);
    } finally {
      await done(root);
    }
  });

  it("reports a freshly built corpus as compatible", async () => {
    const root = await builtProject();
    try {
      assert.equal(((await status(root)).json as CorpusInfoDto).compatible, true);
    } finally {
      await done(root);
    }
  });

  it("names the embedding that built it", async () => {
    const root = await builtProject();
    try {
      const info = (await status(root)).json as CorpusInfoDto;
      assert.match(String(info.embedding["id"]), /^hash-v1/);
      assert.equal(info.embedding["semantic"], false);
    } finally {
      await done(root);
    }
  });

  it("warns that the built-in embedder is not semantic", async () => {
    const root = await builtProject();
    try {
      const info = (await status(root)).json as CorpusInfoDto;
      assert.ok(info.warnings.some((warning) => warning.code === "lexical_embedding"));
    } finally {
      await done(root);
    }
  });

  it("lists the sources with their document counts", async () => {
    const root = await builtProject();
    try {
      const info = (await status(root)).json as CorpusInfoDto;
      assert.equal(info.sources[0]?.id, "docs");
      assert.equal(info.sources[0]?.document_count, 2);
    } finally {
      await done(root);
    }
  });

  it("describes an unbuilt corpus without failing", async () => {
    const root = await makeProject(FIXTURE_DOCS);
    process.env["GRAPHDOG_HOME"] = `${root}/fake-home`;
    try {
      await run(initSpec, runInit, root, ["demo"]);
      const info = (await status(root)).json as CorpusInfoDto;
      assert.equal(info.freshness.status, "unknown");
      assert.equal(info.counts["documents"], 0);
    } finally {
      await done(root);
    }
  });
});

describe("cli/application/commands/list", () => {
  it("lists the corpora it can see", async () => {
    const root = await builtProject();
    try {
      const listing = (await list(root)).json as CorpusListDto;
      assert.equal(listing.corpora.length, 1);
      assert.equal(listing.corpora[0]?.name, "demo");
      assert.equal(listing.corpora[0]?.scope, "project");
    } finally {
      await done(root);
    }
  });

  it("reports document counts per corpus", async () => {
    const root = await builtProject();
    try {
      const listing = (await list(root)).json as CorpusListDto;
      assert.equal(listing.corpora[0]?.document_count, 2);
    } finally {
      await done(root);
    }
  });

  it("returns an empty list rather than failing when there is nothing", async () => {
    const root = await makeProject();
    process.env["GRAPHDOG_HOME"] = `${root}/fake-home`;
    try {
      const listing = (await list(root)).json as CorpusListDto;
      assert.deepEqual(listing.corpora, []);
    } finally {
      await done(root);
    }
  });
});
