import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  ArchiveError,
  ConflictError,
  UsageError,
  type ArchiveReportDto,
  type SearchResponseDto,
} from "@graphdog/core";

import { FIXTURE_DOCS, cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { addSpec, runAdd } from "./add.ts";
import { buildSpec, runBuild } from "./build.ts";
import { initSpec, runInit } from "./init.ts";
import { runSearch, searchSpec } from "./search.ts";
import { exportSpec, importSpec, runExport, runImport } from "./archive.ts";

const originalHome = process.env["GRAPHDOG_HOME"];
const roots: string[] = [];

before(() => {
  // Every test gets its own home workspace; see `fresh`.
});
after(async () => {
  if (originalHome === undefined) delete process.env["GRAPHDOG_HOME"];
  else process.env["GRAPHDOG_HOME"] = originalHome;
  for (const root of roots) await cleanup(root);
});

/** A built project, plus a private home workspace and an unrelated directory to import from. */
async function fresh(): Promise<{ project: string; elsewhere: string }> {
  const project = await makeProject(FIXTURE_DOCS);
  roots.push(project);
  process.env["GRAPHDOG_HOME"] = join(project, "home");
  await run(initSpec, runInit, project, ["demo"]);
  await run(addSpec, runAdd, project, ["./docs"]);
  await run(buildSpec, (context) => runBuild(context, true), project, []);

  const elsewhere = await makeProject();
  roots.push(elsewhere);
  return { project, elsewhere };
}

const exporting = (cwd: string, argv: readonly string[]) => run(exportSpec, runExport, cwd, argv);
const importing = (cwd: string, argv: readonly string[]) => run(importSpec, runImport, cwd, argv);

describe("cli/application/commands/archive", () => {
  describe("export", () => {
    it("writes <corpus>.gdog in the working directory and reports it", async () => {
      const { project } = await fresh();
      const report = (await exporting(project, [])).json as ArchiveReportDto;
      assert.equal(report.kind, "archive_report");
      assert.equal(report.operation, "export");
      assert.equal(report.archive_path, join(project, "demo.gdog"));
      assert.equal((await readFile(report.archive_path)).length, report.bytes);
    });

    it("honours --out", async () => {
      const { project } = await fresh();
      const report = (await exporting(project, ["--out", "out/demo.gdog"])).json as ArchiveReportDto;
      assert.equal(report.archive_path, join(project, "out", "demo.gdog"));
    });

    it("refuses to overwrite an existing archive without --force", async () => {
      const { project } = await fresh();
      await exporting(project, []);
      await assert.rejects(() => exporting(project, []), ConflictError);
      await assert.doesNotReject(() => exporting(project, ["--force"]));
    });

    it("refuses positional arguments rather than guessing they meant --out", async () => {
      const { project } = await fresh();
      await assert.rejects(() => exporting(project, ["demo.gdog"]), UsageError);
    });

    it("prints a receipt with the checksum", async () => {
      const { project } = await fresh();
      const result = await exporting(project, []);
      assert.match(result.human, /exported demo to /);
      assert.match(result.human, /sha256 [0-9a-f]{64}/);
    });
  });

  describe("import", () => {
    it("installs into the home workspace, and the corpus answers searches from anywhere", async () => {
      const { project, elsewhere } = await fresh();
      const exported = (await exporting(project, [])).json as ArchiveReportDto;

      const report = (await importing(elsewhere, [exported.archive_path])).json as ArchiveReportDto;
      assert.equal(report.operation, "import");
      assert.equal(report.destination?.scope, "home");

      const search = (await run(searchSpec, (context) => runSearch(context, "search"), elsewhere, [
        "JWKS",
        "--corpus",
        "demo",
      ])).json as SearchResponseDto;
      assert.equal(search.hits[0]?.ref, "docs/keys.md");
    });

    it("installs under the name given with --as", async () => {
      const { project, elsewhere } = await fresh();
      const exported = (await exporting(project, [])).json as ArchiveReportDto;
      const result = await importing(elsewhere, [exported.archive_path, "--as", "handbook"]);
      assert.equal((result.json as ArchiveReportDto).corpus, "handbook");
      assert.match(result.human, /imported demo as handbook/);
    });

    it("installs into the project workspace with --project", async () => {
      const { project, elsewhere } = await fresh();
      const exported = (await exporting(project, [])).json as ArchiveReportDto;
      await run(initSpec, runInit, elsewhere, ["local"]);
      const report = (await importing(elsewhere, [exported.archive_path, "--project"])).json as ArchiveReportDto;
      assert.equal(report.destination?.scope, "project");
      assert.ok(report.destination?.path.startsWith(join(elsewhere, ".graphdog")));
    });

    it("refuses to replace an existing corpus without --replace", async () => {
      const { project, elsewhere } = await fresh();
      const exported = (await exporting(project, [])).json as ArchiveReportDto;
      await importing(elsewhere, [exported.archive_path]);
      await assert.rejects(() => importing(elsewhere, [exported.archive_path]), ConflictError);

      const report = (await importing(elsewhere, [exported.archive_path, "--replace"])).json as ArchiveReportDto;
      assert.equal(report.destination?.replaced, true);
    });

    it("refuses a file that is not an archive", async () => {
      const { elsewhere } = await fresh();
      await mkdir(join(elsewhere, "downloads"), { recursive: true });
      await writeFile(join(elsewhere, "downloads", "notes.gdog"), "just some text", "utf8");
      await assert.rejects(() => importing(elsewhere, ["downloads/notes.gdog"]), ArchiveError);
    });

    it("requires an archive path", async () => {
      const { elsewhere } = await fresh();
      await assert.rejects(() => importing(elsewhere, []), /an archive path is required/);
    });

    it("takes one archive at a time", async () => {
      const { elsewhere } = await fresh();
      await assert.rejects(() => importing(elsewhere, ["a.gdog", "b.gdog"]), /one archive at a time/);
    });

    it("points --corpus users at --as, rather than letting one flag mean two things", async () => {
      const { elsewhere } = await fresh();
      await assert.rejects(() => importing(elsewhere, ["a.gdog", "--corpus", "x"]), /use --as/);
    });
  });
});
