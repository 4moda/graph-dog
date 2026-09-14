import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ConflictError, UsageError } from "@graphdog/core";

import { cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { addSpec, runAdd } from "./add.ts";
import { initSpec, runInit } from "./init.ts";

async function project(): Promise<string> {
  const root = await makeProject({ "docs/a.md": "# A\n", "spec/b.md": "# B\n" });
  await run(initSpec, runInit, root, ["demo"]);
  return root;
}

const add = (cwd: string, argv: readonly string[]) => run(addSpec, runAdd, cwd, argv);

async function readSources(root: string): Promise<Array<{ id: string; kind: string; uri: string }>> {
  const raw = await readFile(join(root, ".graphdog", "corpora", "demo", "graphdog.json"), "utf8");
  return (JSON.parse(raw) as { sources: Array<{ id: string; kind: string; uri: string }> }).sources;
}

describe("cli/application/commands/add", () => {
  it("registers a local source", async () => {
    const root = await project();
    try {
      await add(root, ["./docs"]);
      const sources = await readSources(root);
      assert.equal(sources.length, 1);
      assert.equal(sources[0]?.kind, "local");
    } finally {
      await cleanup(root);
    }
  });

  it("derives the source id from the folder name", async () => {
    const root = await project();
    try {
      await add(root, ["./docs"]);
      assert.equal((await readSources(root))[0]?.id, "docs");
    } finally {
      await cleanup(root);
    }
  });

  it("stores a project-relative uri, so the config survives a clone", async () => {
    const root = await project();
    try {
      await add(root, ["./docs"]);
      assert.equal((await readSources(root))[0]?.uri, "./docs");
    } finally {
      await cleanup(root);
    }
  });

  it("accepts an explicit id", async () => {
    const root = await project();
    try {
      await add(root, ["./docs", "--id", "handbook"]);
      assert.equal((await readSources(root))[0]?.id, "handbook");
    } finally {
      await cleanup(root);
    }
  });

  it("registers a git source when asked", async () => {
    const root = await project();
    try {
      await add(root, [".", "--git"]);
      assert.equal((await readSources(root))[0]?.kind, "git");
    } finally {
      await cleanup(root);
    }
  });

  it("records include and exclude patterns", async () => {
    const root = await project();
    try {
      await add(root, ["./docs", "--include", "**/*.md", "--exclude", "draft/**"]);
      const raw = await readFile(join(root, ".graphdog", "corpora", "demo", "graphdog.json"), "utf8");
      const source = (JSON.parse(raw) as { sources: Array<Record<string, unknown>> }).sources[0];
      assert.deepEqual(source?.["include"], ["**/*.md"]);
      assert.deepEqual(source?.["exclude"], ["draft/**"]);
    } finally {
      await cleanup(root);
    }
  });

  it("adds a second source alongside the first", async () => {
    const root = await project();
    try {
      await add(root, ["./docs"]);
      await add(root, ["./spec"]);
      assert.deepEqual((await readSources(root)).map((source) => source.id), ["docs", "spec"]);
    } finally {
      await cleanup(root);
    }
  });

  it("refuses the same path twice, which would duplicate every result", async () => {
    const root = await project();
    try {
      await add(root, ["./docs"]);
      await assert.rejects(
        () => add(root, ["./docs"]),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          assert.equal(error.details["existing"], "docs");
          return true;
        },
      );
    } finally {
      await cleanup(root);
    }
  });

  it("refuses an explicit id that is already taken", async () => {
    const root = await project();
    try {
      await add(root, ["./docs"]);
      await assert.rejects(
        () => add(root, ["./spec", "--id", "docs"]),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          assert.match(String(error.details["remedy"]), /--id/);
          return true;
        },
      );
    } finally {
      await cleanup(root);
    }
  });

  it("auto-disambiguates two different folders with the same name", async () => {
    const root = await makeProject({ "a/docs/x.md": "# X\n", "b/docs/y.md": "# Y\n" });
    try {
      await run(initSpec, runInit, root, ["demo"]);
      await add(root, ["./a/docs"]);
      await add(root, ["./b/docs"]);
      assert.deepEqual((await readSources(root)).map((source) => source.id), ["docs", "docs2"]);
    } finally {
      await cleanup(root);
    }
  });

  it("requires a path", async () => {
    const root = await project();
    try {
      await assert.rejects(() => add(root, []), UsageError);
    } finally {
      await cleanup(root);
    }
  });

  it("keeps secret indexing opt-in", async () => {
    const root = await project();
    try {
      await add(root, ["./docs"]);
      const raw = await readFile(join(root, ".graphdog", "corpora", "demo", "graphdog.json"), "utf8");
      const source = (JSON.parse(raw) as { sources: Array<Record<string, unknown>> }).sources[0];
      assert.equal(source?.["indexSecrets"], undefined, "the default must not be written as enabled");
    } finally {
      await cleanup(root);
    }
  });

  it("records the opt-in when it is requested", async () => {
    const root = await project();
    try {
      await add(root, ["./docs", "--index-secrets"]);
      const raw = await readFile(join(root, ".graphdog", "corpora", "demo", "graphdog.json"), "utf8");
      const source = (JSON.parse(raw) as { sources: Array<Record<string, unknown>> }).sources[0];
      assert.equal(source?.["indexSecrets"], true);
    } finally {
      await cleanup(root);
    }
  });

  it("tells the caller to build next", async () => {
    const root = await project();
    try {
      const payload = (await add(root, ["./docs"])).json as { next_steps: string[] };
      assert.deepEqual(payload.next_steps, ["graphdog build"]);
    } finally {
      await cleanup(root);
    }
  });
});
