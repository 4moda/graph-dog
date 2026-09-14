import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ConflictError } from "@graphdog/core";

import { cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { initSpec, runInit } from "./init.ts";

let root: string;
before(async () => {
  root = await makeProject();
});
after(async () => {
  await cleanup(root);
});

const init = (cwd: string, argv: readonly string[]) => run(initSpec, runInit, cwd, argv);

describe("cli/application/commands/init", () => {
  it("creates a corpus config in the project", async () => {
    const project = await makeProject();
    try {
      const result = await init(project, ["docs"]);
      const payload = result.json as { corpus: string; config_path: string };
      assert.equal(payload.corpus, "docs");

      const config = JSON.parse(await readFile(payload.config_path, "utf8")) as { name: string };
      assert.equal(config.name, "docs");
    } finally {
      await cleanup(project);
    }
  });

  it("names the default corpus 'default'", async () => {
    const project = await makeProject();
    try {
      const payload = (await init(project, [])).json as { corpus: string };
      assert.equal(payload.corpus, "default");
    } finally {
      await cleanup(project);
    }
  });

  it("registers sources passed on the command line", async () => {
    const project = await makeProject({ "docs/a.md": "# A\n" });
    try {
      const payload = (await init(project, ["demo", "--source", "./docs"])).json as {
        sources: Array<{ id: string; uri: string }>;
      };
      assert.equal(payload.sources.length, 1);
      assert.equal(payload.sources[0]?.id, "docs");
    } finally {
      await cleanup(project);
    }
  });

  it("tells the caller what to do next", async () => {
    const project = await makeProject();
    try {
      const payload = (await init(project, ["demo"])).json as { next_steps: string[] };
      assert.ok(payload.next_steps.some((step) => step.includes("add")));
    } finally {
      await cleanup(project);
    }
  });

  it("skips the add step when sources were given up front", async () => {
    const project = await makeProject({ "docs/a.md": "# A\n" });
    try {
      const payload = (await init(project, ["demo", "--source", "./docs"])).json as {
        next_steps: string[];
      };
      assert.deepEqual(payload.next_steps, ["graphdog build"]);
    } finally {
      await cleanup(project);
    }
  });

  it("refuses to clobber an existing corpus", async () => {
    const project = await makeProject();
    try {
      await init(project, ["demo"]);
      await assert.rejects(() => init(project, ["demo"]), ConflictError);
    } finally {
      await cleanup(project);
    }
  });

  it("overwrites when --force is given", async () => {
    const project = await makeProject();
    try {
      await init(project, ["demo"]);
      await assert.doesNotReject(() => init(project, ["demo", "--force"]));
    } finally {
      await cleanup(project);
    }
  });

  it("selects the semantic embedder on request", async () => {
    const project = await makeProject();
    try {
      const payload = (await init(project, ["demo", "--semantic"])).json as { config_path: string };
      const config = JSON.parse(await readFile(payload.config_path, "utf8")) as {
        embedding?: { provider?: string };
      };
      assert.equal(config.embedding?.provider, "transformers");
    } finally {
      await cleanup(project);
    }
  });

  it("stores a description when given", async () => {
    const project = await makeProject();
    try {
      const payload = (await init(project, ["demo", "--description", "the docs"])).json as {
        config_path: string;
      };
      const config = JSON.parse(await readFile(payload.config_path, "utf8")) as { description: string };
      assert.equal(config.description, "the docs");
    } finally {
      await cleanup(project);
    }
  });

  it("writes a gitignore that keeps the config but not the index", async () => {
    const project = await makeProject();
    try {
      await init(project, ["demo"]);
      const ignore = await readFile(join(project, ".graphdog", ".gitignore"), "utf8");
      assert.match(ignore, /corpus\.sqlite3/);
    } finally {
      await cleanup(project);
    }
  });
});
