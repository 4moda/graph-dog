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
      assert.deepEqual(
        outcome.changes.map((change) => `${change.kind}:${change.action}`),
        ["key:created", "block:created", "hook:created", "hook:created"],
      );

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
      assert.ok(
        again.changes.every((change) => change.action === "unchanged"),
        JSON.stringify(again.changes),
      );
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
        ["block", "hook", "hook", "key"],
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
        assert.ok(outcome.changes.every((change) => change.action === "created"));
        assert.deepEqual(
          [...new Set(outcome.changes.map((change) => change.path))],
          [join(cwd, ".mcp.json"), join(cwd, "CLAUDE.md"), join(cwd, ".claude", "settings.json")],
        );
        assert.equal(await exists(join(cwd, ".mcp.json")), false);
        assert.equal(await exists(join(cwd, "CLAUDE.md")), false);
        assert.equal(await exists(join(cwd, ".claude", "settings.json")), false);
        assert.deepEqual((await readLedger()).installations, []);
      });
    });
  });

  describe("hooks", () => {
    const settings = (cwd: string): string => join(cwd, ".claude", "settings.json");
    const readJson = async (path: string): Promise<Record<string, Record<string, unknown[]>>> =>
      JSON.parse(await read(path)) as Record<string, Record<string, unknown[]>>;

    it("runs an update when a session opens and when a turn ends", async () => {
      // SessionStart catches the pull and the editing between sessions, before
      // the first search reads the index; Stop catches what the agent just did.
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      const hooks = (await readJson(settings(cwd)))["hooks"];
      assert.deepEqual(Object.keys(hooks ?? {}).sort(), ["SessionStart", "Stop"]);
    });

    it("refreshes every corpus, and cannot fail the turn that triggered it", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      const text = await read(settings(cwd));
      assert.match(text, /graphdog update --all --quiet \|\| true/);
    });

    it("appends beside another tool's hook for the same event", async () => {
      const cwd = await fresh();
      await mkdir(join(cwd, ".claude"), { recursive: true });
      const theirs = { hooks: [{ type: "command", command: "other-tool sync" }] };
      await writeFile(settings(cwd), JSON.stringify({ hooks: { Stop: [theirs] } }, null, 2), "utf8");

      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      const stop = (await readJson(settings(cwd)))["hooks"]?.["Stop"];
      assert.equal(stop?.length, 2);
      assert.deepEqual(stop?.[0], theirs, "theirs stays, and stays first");
    });

    it("removes its own entry and leaves the other tool's", async () => {
      const cwd = await fresh();
      await mkdir(join(cwd, ".claude"), { recursive: true });
      const theirs = { hooks: [{ type: "command", command: "other-tool sync" }] };
      await writeFile(settings(cwd), JSON.stringify({ hooks: { Stop: [theirs] } }, null, 2), "utf8");

      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });

      // Deleting the key rather than the element would have taken theirs too.
      assert.deepEqual((await readJson(settings(cwd)))["hooks"]?.["Stop"], [theirs]);
    });

    it("deletes a settings file that held nothing else", async () => {
      const cwd = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.equal(await exists(settings(cwd)), false);
    });

    it("leaves unrelated settings alone", async () => {
      const cwd = await fresh();
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(settings(cwd), JSON.stringify({ model: "opus" }, null, 2), "utf8");

      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.equal(await read(settings(cwd)), '{\n  "model": "opus"\n}\n');
    });

    it("writes no hooks for a platform that has no hook mechanism", async () => {
      // Copilot's instruction file carries the freshness rule instead, which
      // works because every search reports whether the corpus is stale.
      const cwd = await fresh();
      const outcome = await installAgentIntegration({ platform: "copilot", scope: "project", cwd });
      assert.ok(outcome.changes.every((change) => change.kind !== "hook"));
    });
  });

  describe("git hooks", () => {
    /** A project that is also a git working tree, without running git. */
    async function gitProject(): Promise<string> {
      const cwd = await fresh();
      await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
      return cwd;
    }

    it("is not installed unless asked for", async () => {
      const cwd = await gitProject();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      assert.equal(await exists(join(cwd, ".git", "hooks", "post-commit")), false);
    });

    it("writes the four hooks a tree can change under", async () => {
      const cwd = await gitProject();
      const outcome = await installAgentIntegration({ gitHooks: true, scope: "project", cwd });
      assert.deepEqual(outcome.platforms, ["git"]);
      for (const name of ["post-commit", "post-merge", "post-checkout", "post-rewrite"]) {
        const script = await read(join(cwd, ".git", "hooks", name));
        assert.match(script, /^#!\/bin\/sh/);
        assert.match(script, /# >>> graphdog\ngraphdog update --all --quiet \|\| true\n# <<< graphdog/);
      }
    });

    it("makes the hooks executable, or git would skip them in silence", async () => {
      const cwd = await gitProject();
      await installAgentIntegration({ gitHooks: true, scope: "project", cwd });
      const mode = (await stat(join(cwd, ".git", "hooks", "post-commit"))).mode & 0o777;
      assert.equal(mode & 0o111, 0o111, `mode ${mode.toString(8)}`);
    });

    it("keeps an existing hook script and adds its own lines to it", async () => {
      const cwd = await gitProject();
      const theirs = "#!/bin/sh\nexec other-tool\n";
      await writeFile(join(cwd, ".git", "hooks", "post-commit"), theirs, "utf8");

      await installAgentIntegration({ gitHooks: true, scope: "project", cwd });
      const script = await read(join(cwd, ".git", "hooks", "post-commit"));
      assert.ok(script.startsWith(theirs));

      await uninstallAgentIntegration({ platform: "git", scope: "project", cwd });
      assert.equal(await read(join(cwd, ".git", "hooks", "post-commit")), theirs);
    });

    it("deletes a hook script that was nothing but its own lines", async () => {
      const cwd = await gitProject();
      await installAgentIntegration({ gitHooks: true, scope: "project", cwd });
      await uninstallAgentIntegration({ platform: "git", scope: "project", cwd });
      assert.equal(await exists(join(cwd, ".git", "hooks", "post-commit")), false);
    });

    it("refuses where another tool manages the hooks, naming the line to add", async () => {
      // husky regenerates .git/hooks, so GraphDog's lines would vanish at the
      // next install -- silently, which is the worst way to stop refreshing.
      const cwd = await gitProject();
      await mkdir(join(cwd, ".husky"), { recursive: true });
      await assert.rejects(
        () => installAgentIntegration({ gitHooks: true, scope: "project", cwd }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /managed by husky/);
          assert.match(String(error.details["remedy"]), /graphdog update --all --quiet/);
          return true;
        },
      );
    });

    it("refuses where there is no git working tree", async () => {
      const cwd = await fresh();
      await assert.rejects(
        () => installAgentIntegration({ gitHooks: true, scope: "project", cwd }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /not a git working tree/);
          return true;
        },
      );
    });

    it("refuses an install that was asked to do nothing at all", async () => {
      const cwd = await fresh();
      await assert.rejects(() => installAgentIntegration({ cwd }), ConfigError);
    });

    it("goes with an uninstall that names no platform", async () => {
      const cwd = await gitProject();
      await installAgentIntegration({ platform: "claude", gitHooks: true, scope: "project", cwd });
      await uninstallAgentIntegration({ cwd });
      assert.equal(await exists(join(cwd, ".git", "hooks", "post-commit")), false);
      assert.equal(await exists(join(cwd, "CLAUDE.md")), false);
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
