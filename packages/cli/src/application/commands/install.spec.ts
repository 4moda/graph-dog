import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ConfigError, ConflictError, UsageError, type IntegrationReportDto } from "@graphdog/core";

import { FIXTURE_DOCS, cleanup, makeProject, run } from "./__fixtures__/cli-harness.ts";
import { addSpec, runAdd } from "./add.ts";
import { buildSpec, runBuild } from "./build.ts";
import { initSpec, runInit } from "./init.ts";
import { installSpec, runInstall, runUninstall, uninstallSpec } from "./install.ts";

const roots: string[] = [];
const originalHome = process.env["HOME"];
const originalGraphdogHome = process.env["GRAPHDOG_HOME"];

after(async () => {
  restore("HOME", originalHome);
  restore("GRAPHDOG_HOME", originalGraphdogHome);
  for (const root of roots) await cleanup(root);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** A project, plus a private home so neither the agent's config nor the ledger is the real one. */
async function fresh(files: Record<string, string> = FIXTURE_DOCS): Promise<string> {
  const project = await makeProject(files);
  const home = await makeProject();
  roots.push(project, home);
  process.env["HOME"] = home;
  process.env["GRAPHDOG_HOME"] = join(home, ".graphdog");
  return project;
}

const installing = (cwd: string, argv: readonly string[]) => run(installSpec, runInstall, cwd, argv);
const uninstalling = (cwd: string, argv: readonly string[]) => run(uninstallSpec, runUninstall, cwd, argv);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("cli/application/commands/install", () => {
  it("connects an agent to this project and reports every file it wrote", async () => {
    const cwd = await fresh();
    const result = await installing(cwd, ["--platform", "claude", "--project"]);
    const report = result.json as IntegrationReportDto;

    assert.equal(report.kind, "integration_report");
    assert.equal(report.operation, "install");
    assert.deepEqual(report.platforms, ["claude"]);
    assert.equal(report.scope, "project");
    assert.deepEqual(
      [...new Set(report.changes.map((change) => change.path))],
      [join(cwd, ".mcp.json"), join(cwd, "CLAUDE.md"), join(cwd, ".claude", "settings.json")],
    );
    assert.match(result.human, /connected claude \(project scope\)/);
  });

  it("writes into the agent's own configuration without --project", async () => {
    const cwd = await fresh();
    const report = (await installing(cwd, ["--platform", "claude"])).json as IntegrationReportDto;
    assert.equal(report.scope, "user");
    assert.equal(await exists(join(cwd, ".mcp.json")), false);
  });

  it("keeps the MCP server read-only unless --allow-write is given", async () => {
    const cwd = await fresh();
    await installing(cwd, ["--platform", "claude", "--project"]);
    assert.ok(!(await readFile(join(cwd, ".mcp.json"), "utf8")).includes("--allow-write"));

    await installing(cwd, ["--platform", "claude", "--project", "--allow-write"]);
    assert.ok((await readFile(join(cwd, ".mcp.json"), "utf8")).includes("--allow-write"));
  });

  it("requires a platform rather than picking one", async () => {
    const cwd = await fresh();
    await assert.rejects(() => installing(cwd, []), UsageError);
  });

  it("names the platforms it knows when given one it does not", async () => {
    const cwd = await fresh();
    await assert.rejects(() => installing(cwd, ["--platform", "emacs"]), ConfigError);
  });

  it("refuses a positional argument rather than guessing it meant --platform", async () => {
    const cwd = await fresh();
    await assert.rejects(() => installing(cwd, ["claude"]), UsageError);
  });

  describe("--dry-run", () => {
    it("says what it would write, writes nothing, and marks the report", async () => {
      const cwd = await fresh();
      const result = await installing(cwd, ["--platform", "claude", "--project", "--dry-run"]);
      const report = result.json as IntegrationReportDto;

      assert.equal(report.dry_run, true);
      assert.match(result.human, /would connect claude/);
      assert.ok(result.human.includes(join(cwd, "CLAUDE.md")), "the human output names the file");
      assert.equal(await exists(join(cwd, "CLAUDE.md")), false);
    });
  });
});

describe("cli/application/commands/uninstall", () => {
  it("removes what install wrote and leaves the rest of the file", async () => {
    const cwd = await fresh({ "CLAUDE.md": "# House rules\n" });
    await installing(cwd, ["--platform", "claude", "--project"]);

    const result = await uninstalling(cwd, ["--platform", "claude", "--project"]);
    const report = result.json as IntegrationReportDto;

    assert.equal(report.operation, "uninstall");
    assert.ok(report.changes.some((change) => change.action === "removed"));
    assert.equal(await readFile(join(cwd, "CLAUDE.md"), "utf8"), "# House rules\n");
    assert.match(result.human, /removed claude/);
  });

  it("removes every platform when none is named", async () => {
    const cwd = await fresh();
    await installing(cwd, ["--platform", "claude", "--project"]);
    await installing(cwd, ["--platform", "kiro", "--project"]);

    await uninstalling(cwd, []);
    assert.equal(await exists(join(cwd, "CLAUDE.md")), false);
    assert.equal(await exists(join(cwd, ".kiro", "steering", "graphdog.md")), false);
  });

  it("reports an integration that was never installed as absent, not as an error", async () => {
    const cwd = await fresh();
    const report = (await uninstalling(cwd, ["--platform", "claude", "--project"])).json as IntegrationReportDto;
    assert.ok(report.changes.every((change) => change.action === "absent"));
  });

  it("does not disturb another tool sharing the same files", async () => {
    const cwd = await fresh({
      "CLAUDE.md": "<!-- code-review-graph -->\ntheirs\n<!-- /code-review-graph -->\n",
    });
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { "code-review-graph": { command: "crg" } } }, null, 2),
      "utf8",
    );

    await installing(cwd, ["--platform", "claude", "--project"]);
    await uninstalling(cwd, ["--platform", "claude", "--project"]);

    assert.equal(
      await readFile(join(cwd, "CLAUDE.md"), "utf8"),
      "<!-- code-review-graph -->\ntheirs\n<!-- /code-review-graph -->\n",
    );
    const mcp = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as Record<string, object>;
    assert.deepEqual(Object.keys(mcp["mcpServers"] ?? {}), ["code-review-graph"]);
  });

  describe("--purge", () => {
    it("refuses without --yes, and says what it would have deleted", async () => {
      const cwd = await fresh();
      await run(initSpec, runInit, cwd, ["docs"]);
      await assert.rejects(() => uninstalling(cwd, ["--purge"]), ConflictError);
    });

    it("deletes the index when confirmed, and reports the bytes freed", async () => {
      const cwd = await fresh();
      await run(initSpec, runInit, cwd, ["docs"]);
      await run(addSpec, runAdd, cwd, ["./docs"]);
      await run(buildSpec, (context) => runBuild(context, true), cwd, []);

      const result = await uninstalling(cwd, ["--purge", "--yes"]);
      const report = result.json as IntegrationReportDto;
      const data = report.changes.filter((change) => change.kind === "data");
      assert.ok(data.length > 0);
      assert.ok(data.every((change) => typeof change.bytes === "number"));
      assert.equal(await exists(join(cwd, ".graphdog", "corpora", "docs", "corpus.sqlite3")), false);
      assert.ok(await exists(join(cwd, ".graphdog", "corpora", "docs", "graphdog.json")), "the config stays");
    });
  });

  describe("--dry-run", () => {
    it("lists what would go and leaves it there", async () => {
      const cwd = await fresh();
      await installing(cwd, ["--platform", "claude", "--project"]);
      const report = (await uninstalling(cwd, ["--platform", "claude", "--project", "--dry-run"]))
        .json as IntegrationReportDto;

      assert.equal(report.dry_run, true);
      assert.ok(report.changes.some((change) => change.action === "removed"));
      assert.ok(await exists(join(cwd, "CLAUDE.md")));
    });
  });
});
