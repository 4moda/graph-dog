import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ConfigError } from "../domain/errors.ts";
import { initProjectWorkspace } from "../infrastructure/config/workspace.ts";
import { readLedger } from "../infrastructure/integration/installation-ledger.ts";
import { installAgentIntegration, knownPlatforms, uninstallAgentIntegration } from "./agent-integration.ts";

let root: string;
const originalHome = process.env["HOME"];
const originalGraphdogHome = process.env["GRAPHDOG_HOME"];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-integration-"));
});
after(async () => {
  restore("HOME", originalHome);
  restore("GRAPHDOG_HOME", originalGraphdogHome);
  await rm(root, { recursive: true, force: true });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

let counter = 0;

/** A project directory with a corpus workspace, and a private home for both the agent and GraphDog. */
async function fresh(): Promise<string> {
  counter += 1;
  const project = join(root, `project-${counter}`);
  const home = join(root, `home-${counter}`);
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  process.env["HOME"] = home;
  process.env["GRAPHDOG_HOME"] = join(home, ".graphdog");
  await initProjectWorkspace(project);
  return project;
}

const read = (path: string): Promise<string> => readFile(path, "utf8");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("composition/agent-integration", () => {
  describe("installAgentIntegration", () => {
    it("registers the MCP server and writes instructions, for Claude Code in a project", async () => {
      const cwd = await fresh();
      const outcome = await installAgentIntegration({ platform: "claude", scope: "project", cwd });

      assert.equal(outcome.operation, "install");
      assert.deepEqual(outcome.changes.map((change) => change.action), ["created", "created"]);

      const mcp = JSON.parse(await read(join(cwd, ".mcp.json"))) as Record<string, Record<string, unknown>>;
      assert.deepEqual(mcp["mcpServers"]?.["graphdog"], { command: "graphdog-mcp", args: [] });
      assert.match(await read(join(cwd, "CLAUDE.md")), /<!-- graphdog -->[\s\S]*Search before you read/);
    });

    it("registers the server read-only unless writes were asked for", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd, allowWrite: true });
      const mcp = JSON.parse(await read(join(cwd, ".mcp.json"))) as Record<string, Record<string, Record<string, unknown>>>;
      assert.deepEqual(mcp["mcpServers"]?.["graphdog"]?.["args"], ["--allow-write"]);
    });

    it("runs the installed binary from PATH, never npx", async () => {
      // An agent's first search must not be a download, and a Homebrew Cellar
      // path would not survive an upgrade.
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      const text = await read(join(cwd, ".mcp.json"));
      assert.ok(!text.includes("npx"), text);
      assert.match(text, /"command": "graphdog-mcp"/);
    });

    it("writes its own instruction file where the platform reads a directory of them", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "copilot", scope: "project", cwd });
      assert.match(
        await read(join(cwd, ".github", "instructions", "graphdog.instructions.md")),
        /Search before you read/,
      );
      const mcp = JSON.parse(await read(join(cwd, ".vscode", "mcp.json"))) as Record<string, unknown>;
      assert.ok("servers" in mcp, "VS Code names the container 'servers', not 'mcpServers'");
    });

    it("writes Kiro's steering file and settings", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "kiro", scope: "project", cwd });
      assert.ok(await exists(join(cwd, ".kiro", "steering", "graphdog.md")));
      assert.ok(await exists(join(cwd, ".kiro", "settings", "mcp.json")));
    });

    it("writes at the top of the repository when run from a subdirectory", async () => {
      const cwd = await fresh();
      const deep = join(cwd, "docs", "design");
      await mkdir(deep, { recursive: true });
      await installAgentIntegration({ platform: "claude", scope: "project", cwd: deep });
      assert.ok(await exists(join(cwd, ".mcp.json")), "the agent looks at the repository root");
      assert.equal(await exists(join(deep, ".mcp.json")), false);
    });

    it("leaves another tool's MCP server and instruction block alone", async () => {
      const cwd = await fresh();
      await writeFile(
        join(cwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { "code-review-graph": { command: "crg" } } }, null, 2),
        "utf8",
      );
      await writeFile(
        join(cwd, "CLAUDE.md"),
        "# Project\n\n<!-- code-review-graph -->\ntheirs\n<!-- /code-review-graph -->\n",
        "utf8",
      );

      await installAgentIntegration({ platform: "claude", scope: "project", cwd });

      const mcp = JSON.parse(await read(join(cwd, ".mcp.json"))) as Record<string, Record<string, unknown>>;
      assert.ok(mcp["mcpServers"]?.["code-review-graph"], "the other server must survive");
      const instructions = await read(join(cwd, "CLAUDE.md"));
      assert.ok(instructions.startsWith("# Project\n"));
      assert.ok(instructions.includes("<!-- code-review-graph -->\ntheirs\n<!-- /code-review-graph -->"));
    });

    it("is idempotent: installing twice reports the second run changed nothing", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      const again = await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.deepEqual(again.changes.map((change) => change.action), ["unchanged", "unchanged"]);
    });

    it("installs into the user's own configuration by default", async () => {
      const cwd = await fresh();
      const outcome = await installAgentIntegration({ platform: "claude", cwd });
      assert.equal(outcome.scope, "user");
      assert.ok(await exists(join(process.env["HOME"] ?? "", ".claude.json")));
      assert.equal(await exists(join(cwd, ".mcp.json")), false);
    });

    it("refuses a scope a platform does not have, saying which one to use", async () => {
      const cwd = await fresh();
      await assert.rejects(
        () => installAgentIntegration({ platform: "copilot", scope: "user", cwd }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /no user-scope integration/);
          assert.match(error.message, /install into the project/);
          return true;
        },
      );
    });

    it("refuses an unknown platform and names the ones it knows", async () => {
      const cwd = await fresh();
      await assert.rejects(
        () => installAgentIntegration({ platform: "cursor", cwd }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(String(error.details["remedy"]), /claude/);
          return true;
        },
      );
    });

    it("records what it wrote in the ledger, with the version that wrote it", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      const [record, ...rest] = (await readLedger()).installations;
      assert.deepEqual(rest, []);
      assert.equal(record?.platform, "claude");
      assert.equal(record?.root, cwd);
      assert.notEqual(record?.version, undefined);
      assert.deepEqual(
        record?.artifacts.map((artifact) => artifact.kind).sort(),
        ["block", "key"],
      );
    });

    it("re-installing replaces the ledger entry rather than adding a second", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.equal((await readLedger()).installations.length, 1);
    });

    describe("--dry-run", () => {
      it("reports every file it would write and writes none of them", async () => {
        const cwd = await fresh();
        const outcome = await installAgentIntegration({ platform: "claude", scope: "project", cwd, dryRun: true });
        assert.deepEqual(outcome.changes.map((change) => change.action), ["created", "created"]);
        assert.deepEqual(
          outcome.changes.map((change) => change.path),
          [join(cwd, ".mcp.json"), join(cwd, "CLAUDE.md")],
        );
        assert.equal(await exists(join(cwd, ".mcp.json")), false);
        assert.equal(await exists(join(cwd, "CLAUDE.md")), false);
        assert.deepEqual((await readLedger()).installations, []);
      });
    });
  });

  describe("uninstallAgentIntegration", () => {
    it("takes back a file it created entirely", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "copilot", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "copilot", scope: "project", cwd });
      assert.equal(await exists(join(cwd, ".github", "instructions", "graphdog.instructions.md")), false);
      assert.equal(await exists(join(cwd, ".vscode", "mcp.json")), false, "an emptied config is deleted too");
    });

    it("leaves a file it only added to, minus its own block", async () => {
      const cwd = await fresh();
      const original = "# Project\n\nHouse rules.\n";
      await writeFile(join(cwd, "CLAUDE.md"), original, "utf8");

      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });

      assert.equal(await read(join(cwd, "CLAUDE.md")), original, "byte for byte what was there before");
    });

    it("leaves another tool's MCP entry and keeps the file", async () => {
      const cwd = await fresh();
      await writeFile(
        join(cwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { "code-review-graph": { command: "crg" } } }, null, 2),
        "utf8",
      );
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });

      const mcp = JSON.parse(await read(join(cwd, ".mcp.json"))) as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(mcp["mcpServers"] ?? {}), ["code-review-graph"]);
    });

    it("deletes a CLAUDE.md that held nothing but GraphDog's block", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.equal(await exists(join(cwd, "CLAUDE.md")), false);
    });

    it("clears the ledger entry", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.deepEqual((await readLedger()).installations, []);
    });

    it("removes every platform when none is named", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await installAgentIntegration({ platform: "kiro", scope: "project", cwd });

      await uninstallAgentIntegration({ cwd });
      assert.equal(await exists(join(cwd, "CLAUDE.md")), false);
      assert.equal(await exists(join(cwd, ".kiro", "steering", "graphdog.md")), false);
      assert.deepEqual((await readLedger()).installations, []);
    });

    it("leaves a platform that was not named installed", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await installAgentIntegration({ platform: "kiro", scope: "project", cwd });

      await uninstallAgentIntegration({ platform: "kiro", scope: "project", cwd });
      assert.ok(await exists(join(cwd, "CLAUDE.md")));
      assert.deepEqual((await readLedger()).installations.map((r) => r.platform), ["claude"]);
    });

    it("removes a project integration from a clone this machine never installed into", async () => {
      // A project-scope install is committed, so the ledger of the machine
      // doing the uninstall has never heard of these files.
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await rm(join(process.env["GRAPHDOG_HOME"] ?? "", "installed.json"), { force: true });

      const outcome = await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.ok(outcome.changes.some((change) => change.action === "removed"));
      assert.equal(await exists(join(cwd, "CLAUDE.md")), false);
    });

    it("takes the directories it created with it, and leaves ones it did not", async () => {
      const cwd = await fresh();
      await mkdir(join(cwd, ".vscode"), { recursive: true });
      await writeFile(join(cwd, ".vscode", "settings.json"), "{}", "utf8");

      await installAgentIntegration({ platform: "copilot", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "copilot", scope: "project", cwd });

      assert.equal(await exists(join(cwd, ".github")), false, "GraphDog created .github/instructions");
      assert.ok(await exists(join(cwd, ".vscode", "settings.json")), "somebody else's file keeps its directory");
    });

    it("reports what was already gone as absent rather than failing", async () => {
      const cwd = await fresh();
      const outcome = await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.ok(outcome.changes.every((change) => change.action === "absent"));
    });

    it("does not touch a marker block another tool owns", async () => {
      const cwd = await fresh();
      const theirs = "<!-- code-review-graph -->\ntheirs\n<!-- /code-review-graph -->\n";
      await writeFile(join(cwd, "CLAUDE.md"), theirs, "utf8");
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.equal(await read(join(cwd, "CLAUDE.md")), theirs);
    });

    describe("--dry-run", () => {
      it("lists what it would remove and removes nothing", async () => {
        const cwd = await fresh();
        await installAgentIntegration({ platform: "claude", scope: "project", cwd });
        const outcome = await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd, dryRun: true });

        assert.ok(outcome.changes.some((change) => change.action === "removed"));
        assert.ok(await exists(join(cwd, ".mcp.json")));
        assert.ok(await exists(join(cwd, "CLAUDE.md")));
        assert.equal((await readLedger()).installations.length, 1);
      });
    });
  });

  describe("knownPlatforms", () => {
    it("names each platform and the scopes it supports", () => {
      const platforms = knownPlatforms();
      assert.deepEqual(platforms.map((platform) => platform.id), ["claude", "copilot", "kiro"]);
      assert.deepEqual(platforms.find((platform) => platform.id === "claude")?.scopes, ["project", "user"]);
      assert.deepEqual(platforms.find((platform) => platform.id === "copilot")?.scopes, ["project"]);
    });
  });
});
