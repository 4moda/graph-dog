import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ConfigError, ExitCode, type BuildReportDto, type BuildReportsDto } from "@graphdog/core";

import { FIXTURE_DOCS, cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { addSpec, runAdd } from "./add.ts";
import { buildSpec, runBuild, updateSpec } from "./build.ts";
import { initSpec, runInit } from "./init.ts";

async function project(files = FIXTURE_DOCS): Promise<string> {
  const root = await makeProject(files);
  await run(initSpec, runInit, root, ["demo"]);
  await run(addSpec, runAdd, root, ["./docs"]);
  return root;
}

const build = (cwd: string, argv: readonly string[] = []) =>
  run(buildSpec, (context) => runBuild(context, true), cwd, argv);
const update = (cwd: string, argv: readonly string[] = []) =>
  run(updateSpec, (context) => runBuild(context, false), cwd, argv);

describe("cli/application/commands/build --all", () => {
  it("builds every corpus visible from here, reporting each", async () => {
    // A hook that refreshed the first of three corpora would be exactly the
    // silent staleness the trigger exists to prevent.
    const root = await makeProject(FIXTURE_DOCS);
    try {
      await run(initSpec, runInit, root, ["docs"]);
      await run(addSpec, runAdd, root, ["./docs", "--corpus", "docs"]);
      await run(initSpec, runInit, root, ["notes"]);
      await run(addSpec, runAdd, root, ["./docs", "--corpus", "notes"]);

      const result = await build(root, ["--all"]);
      const report = result.json as BuildReportsDto;
      assert.equal(report.kind, "build_reports");
      assert.deepEqual(report.reports.map((one) => one.corpus).sort(), ["docs", "notes"]);
      assert.equal(report.status, "ok");
      assert.ok(result.human.includes("docs") && result.human.includes("notes"));
    } finally {
      await cleanup(root);
    }
  });

  it("returns a single report, not a list, when there is one corpus", async () => {
    const root = await project();
    try {
      const report = (await build(root, ["--all"])).json as BuildReportDto;
      assert.equal(report.kind, "build_report");
    } finally {
      await cleanup(root);
    }
  });

  it("refuses --all where there are no corpora, rather than reporting success", async () => {
    const root = await makeProject();
    try {
      await assert.rejects(() => update(root, ["--all"]), ConfigError);
    } finally {
      await cleanup(root);
    }
  });
});

describe("cli/application/commands/build", () => {
  it("indexes the configured sources", async () => {
    const root = await project();
    try {
      const report = (await build(root)).json as BuildReportDto;
      assert.equal(report.status, "ok");
      assert.equal(report.documents.added, 2);
      assert.ok(report.chunks > 0);
    } finally {
      await cleanup(root);
    }
  });

  it("builds the relation graph", async () => {
    const root = await project();
    try {
      const report = (await build(root)).json as BuildReportDto;
      assert.ok(report.edges > 0, "documents sharing a tag should be connected");
    } finally {
      await cleanup(root);
    }
  });

  it("exits zero on a clean build", async () => {
    const root = await project();
    try {
      assert.equal((await build(root)).exitCode ?? ExitCode.OK, ExitCode.OK);
    } finally {
      await cleanup(root);
    }
  });

  it("refuses to build a corpus with no sources, and says what to do", async () => {
    const root = await makeProject();
    try {
      await run(initSpec, runInit, root, ["demo"]);
      await assert.rejects(
        () => build(root),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(String(error.details["remedy"]), /graphdog add/);
          return true;
        },
      );
    } finally {
      await cleanup(root);
    }
  });

  describe("update", () => {
    it("reports unchanged files rather than re-indexing them", async () => {
      const root = await project();
      try {
        await build(root);
        const report = (await update(root)).json as BuildReportDto;
        assert.equal(report.documents.unchanged, 2);
        assert.equal(report.documents.modified, 0);
      } finally {
        await cleanup(root);
      }
    });

    it("picks up an edited file", async () => {
      const root = await project();
      try {
        await build(root);
        await writeFile(join(root, "docs", "keys.md"), "# Key Management\n\nrewritten entirely\n", "utf8");
        const report = (await update(root)).json as BuildReportDto;
        assert.equal(report.documents.modified, 1);
      } finally {
        await cleanup(root);
      }
    });

    it("notices a deleted file", async () => {
      const root = await project();
      try {
        await build(root);
        await rm(join(root, "docs", "keys.md"));
        const report = (await update(root)).json as BuildReportDto;
        assert.equal(report.documents.deleted, 1);
      } finally {
        await cleanup(root);
      }
    });

    it("re-indexes everything with --full", async () => {
      const root = await project();
      try {
        await build(root);
        const report = (await update(root, ["--full"])).json as BuildReportDto;
        assert.equal(report.documents.modified, 2);
        assert.equal(report.documents.unchanged, 0);
      } finally {
        await cleanup(root);
      }
    });
  });

  describe("partial builds", () => {
    it("reports partial and exits non-zero when a file cannot be indexed", async () => {
      const root = await project({
        ...FIXTURE_DOCS,
        // A PDF with no extractor installed: the build must continue and report.
        "docs/broken.pdf": "%PDF-1.4 not really a pdf",
      });
      try {
        const result = await build(root);
        const report = result.json as BuildReportDto;
        assert.equal(report.status, "partial");
        assert.equal(result.exitCode, ExitCode.PARTIAL);
        assert.ok(report.failures.some((failure) => failure.ref.endsWith("broken.pdf")));
      } finally {
        await cleanup(root);
      }
    });

    it("still indexes the files that worked", async () => {
      const root = await project({ ...FIXTURE_DOCS, "docs/broken.pdf": "%PDF-1.4 nope" });
      try {
        const report = (await build(root)).json as BuildReportDto;
        assert.equal(report.documents.added, 2, "the good documents must still be indexed");
      } finally {
        await cleanup(root);
      }
    });
  });

  describe("auditability", () => {
    it("records files skipped as secrets", async () => {
      const root = await project({ ...FIXTURE_DOCS, "docs/service-account.json": "{}" });
      try {
        const report = (await build(root)).json as BuildReportDto;
        assert.ok(
          report.exclusions.some((entry) => entry.reason === "secret_pattern"),
          "a skipped secret must be recorded, not silently absent",
        );
      } finally {
        await cleanup(root);
      }
    });

    it("restricts the build to a named source", async () => {
      const root = await project();
      try {
        const report = (await build(root, ["--source", "nonexistent"])).json as BuildReportDto;
        assert.equal(report.documents.added, 0);
      } finally {
        await cleanup(root);
      }
    });
  });
});
