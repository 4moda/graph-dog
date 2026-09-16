import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { defaultCorpusConfig } from "../application/config.ts";
import { CORPUS_META_KEYS } from "../application/corpus-meta.ts";
import { saveCorpusConfig } from "../infrastructure/config/corpus-config-file.ts";
import {
  corpusConfigPath,
  corpusStorePath,
  initProjectWorkspace,
  type Workspace,
} from "../infrastructure/config/workspace.ts";
import { SqliteCorpusStore } from "../infrastructure/persistence/sqlite/sqlite-corpus-store.ts";
import { installAgentIntegration } from "./agent-integration.ts";
import { runDoctor, type DoctorFinding, type DoctorReport } from "./doctor.ts";

let root: string;
const originalHome = process.env["HOME"];
const originalGraphdogHome = process.env["GRAPHDOG_HOME"];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-doctor-"));
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

async function fresh(): Promise<{ cwd: string; workspace: Workspace }> {
  counter += 1;
  const cwd = join(root, `project-${counter}`);
  const home = join(root, `home-${counter}`);
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  process.env["HOME"] = home;
  process.env["GRAPHDOG_HOME"] = join(home, ".graphdog");
  return { cwd, workspace: await initProjectWorkspace(cwd) };
}

/** Add a corpus config, and optionally a built database with the given meta. */
async function addCorpus(
  workspace: Workspace,
  name: string,
  meta: Record<string, string> | null,
): Promise<void> {
  await saveCorpusConfig(corpusConfigPath(workspace, name), defaultCorpusConfig(name));
  if (meta === null) return;
  const store = await SqliteCorpusStore.open(corpusStorePath(workspace, name));
  for (const [key, value] of Object.entries(meta)) store.meta.set(key, value);
  store.close();
}

const find = (report: DoctorReport, section: DoctorFinding["section"]): DoctorFinding[] =>
  report.findings.filter((finding) => finding.section === section);

describe("composition/doctor", () => {
  it("reports the version it is and the node it runs on", async () => {
    const { cwd } = await fresh();
    const report = await runDoctor({ cwd });
    assert.match(report.version, /^\d+\.\d+\.\d+/);
    assert.equal(report.node, process.version);
  });

  it("is healthy when there is nothing installed and nothing built", async () => {
    const { cwd } = await fresh();
    const report = await runDoctor({ cwd });
    assert.equal(report.healthy, true);
    assert.ok(find(report, "agents").every((finding) => finding.status === "ok"));
  });

  describe("agents", () => {
    it("reports an installed integration as ok, with the version that wrote it", async () => {
      const { cwd } = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      const [finding] = find(await runDoctor({ cwd }), "agents");
      assert.match(finding?.label ?? "", /^claude/);
      assert.equal(finding?.status, "ok");
    });

    it("calls it broken when a file it wrote has gone, and says how to put it back", async () => {
      // Half an integration is worse than none: the agent may still start the
      // server while the instructions telling it what to do with it are gone.
      const { cwd } = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      await rm(join(cwd, "CLAUDE.md"));

      const report = await runDoctor({ cwd });
      const [finding] = find(report, "agents");
      assert.equal(finding?.status, "broken");
      assert.match(finding?.detail ?? "", /missing/);
      assert.equal(finding?.remedy, "graphdog install --platform claude --project");
      assert.equal(report.healthy, false, "and the command exits non-zero on it");
    });

    it("warns about an integration an older version wrote, which is not a failure", async () => {
      const { cwd } = await fresh();
      await installAgentIntegration({ platform: "claude", scope: "project", cwd });
      // Rewrite the ledger as an older release would have left it.
      const path = join(process.env["GRAPHDOG_HOME"] ?? "", "installed.json");
      const ledger = JSON.parse(await readText(path)) as { installations: Array<{ version: string }> };
      for (const record of ledger.installations) record.version = "0.0.1";
      await writeFile(path, JSON.stringify(ledger, null, 2), "utf8");

      const report = await runDoctor({ cwd });
      const [finding] = find(report, "agents");
      assert.equal(finding?.status, "warn");
      assert.match(finding?.detail ?? "", /written by 0\.0\.1/);
      assert.equal(report.healthy, true, "a warning is worth knowing, not worth failing on");
    });

    it("names the git-hooks command for the git entry, not a --platform one", async () => {
      const { cwd } = await fresh();
      await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
      await installAgentIntegration({ gitHooks: true, scope: "project", cwd });
      await rm(join(cwd, ".git", "hooks", "post-commit"));

      const [finding] = find(await runDoctor({ cwd }), "agents");
      assert.equal(finding?.remedy, "graphdog install --git-hooks --project");
    });
  });

  describe("corpora", () => {
    it("warns about a corpus that was configured and never built", async () => {
      const { cwd, workspace } = await fresh();
      await addCorpus(workspace, "docs", null);
      const [finding] = find(await runDoctor({ cwd }), "corpora");
      assert.equal(finding?.status, "warn");
      assert.equal(finding?.remedy, "graphdog build --corpus docs");
    });

    it("reports a built corpus with when it was built and by which embedder", async () => {
      const { cwd, workspace } = await fresh();
      await addCorpus(workspace, "docs", {
        [CORPUS_META_KEYS.builtAt]: "2026-09-16T00:00:00.000Z",
        [CORPUS_META_KEYS.embeddingId]: "hash-v1:d256",
      });
      const [finding] = find(await runDoctor({ cwd }), "corpora");
      assert.equal(finding?.status, "ok");
      assert.match(finding?.detail ?? "", /2026-09-16.*hash-v1:d256/);
    });

    it("calls a corpus from another schema broken, and names the rebuild", async () => {
      const { cwd, workspace } = await fresh();
      await addCorpus(workspace, "docs", {
        [CORPUS_META_KEYS.schemaVersion]: "99",
        [CORPUS_META_KEYS.builtAt]: "2026-09-16T00:00:00.000Z",
      });
      const report = await runDoctor({ cwd });
      const [finding] = find(report, "corpora");
      assert.equal(finding?.status, "broken");
      assert.equal(finding?.remedy, "graphdog build --full --corpus docs");
      assert.equal(report.healthy, false);
    });

    it("calls an unreadable database broken rather than throwing", async () => {
      const { cwd, workspace } = await fresh();
      await saveCorpusConfig(corpusConfigPath(workspace, "docs"), defaultCorpusConfig("docs"));
      await writeFile(corpusStorePath(workspace, "docs"), "not a database at all", "utf8");

      const [finding] = find(await runDoctor({ cwd }), "corpora");
      assert.equal(finding?.status, "broken");
    });

    it("never loads an embedding model to decide compatibility", async () => {
      // A semantic corpus's model could be a download, and `doctor` is the
      // command you run to find out whether things are in order.
      const { cwd, workspace } = await fresh();
      const config = defaultCorpusConfig("docs");
      await saveCorpusConfig(corpusConfigPath(workspace, "docs"), {
        ...config,
        embedding: { ...config.embedding, provider: "transformers", model: "not-a-real-model" },
      });
      await addCorpus(workspace, "docs", { [CORPUS_META_KEYS.builtAt]: "2026-09-16T00:00:00.000Z" });

      const [finding] = find(await runDoctor({ cwd }), "corpora");
      assert.equal(finding?.status, "ok", "it read the recorded identity, it did not build one");
    });
  });

  describe("extras", () => {
    it("sees a package whose exports hide its package.json", async () => {
      // `@huggingface/transformers` does not list `./package.json` in its
      // exports, so asking for that file fails with ERR_PACKAGE_PATH_NOT_EXPORTED
      // while the package is perfectly well installed. Reporting semantic
      // embeddings as missing on a machine that has them sends people to
      // reinstall something they already have.
      const { cwd } = await fresh();
      const extras = find(await runDoctor({ cwd }), "extras");
      const semantic = extras.find((finding) => finding.label === "semantic embeddings");
      const present = (() => {
        try {
          createRequire(import.meta.url).resolve("@huggingface/transformers");
          return true;
        } catch {
          return false;
        }
      })();
      assert.equal(
        semantic?.detail.includes("available"),
        present,
        "doctor must agree with whether the module resolves at all",
      );
    });

    it("lists each optional capability, and never calls a missing one a fault", async () => {
      // Working with none of them installed is the documented default.
      const { cwd } = await fresh();
      const extras = find(await runDoctor({ cwd }), "extras");
      assert.equal(extras.length, 3);
      assert.ok(extras.every((finding) => finding.status === "ok"));
      assert.ok(extras.some((finding) => finding.label === "PDF extraction"));
    });
  });
});

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
