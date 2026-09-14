import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { ConfigError, CorpusNotFoundError } from "../../domain/errors.ts";
import { defaultCorpusConfig } from "../../application/config.ts";
import { saveCorpusConfig } from "./corpus-config-file.ts";
import {
  WORKSPACE_DIRNAME,
  assertValidCorpusName,
  corpusConfigPath,
  corpusStorePath,
  findProjectWorkspace,
  homeWorkspace,
  initProjectWorkspace,
  listCorpusNames,
  resolveCorpus,
  resolveSourceUri,
  visibleWorkspaces,
} from "./workspace.ts";

let root: string;
const originalHome = process.env["GRAPHDOG_HOME"];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-ws-"));
  // Point the home workspace somewhere empty so these tests never see, or
  // disturb, a real one on the machine running them.
  process.env["GRAPHDOG_HOME"] = join(root, "fake-home");
});

after(async () => {
  if (originalHome === undefined) delete process.env["GRAPHDOG_HOME"];
  else process.env["GRAPHDOG_HOME"] = originalHome;
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
async function freshProject(): Promise<string> {
  counter += 1;
  const directory = join(root, `project-${counter}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

afterEach(() => undefined);

describe("infrastructure/config/workspace", () => {
  describe("corpus names", () => {
    it("accepts ordinary names", () => {
      for (const name of ["docs", "oip-cvp-auth", "v1.2", "a_b"]) {
        assert.doesNotThrow(() => assertValidCorpusName(name));
      }
    });

    it("rejects names that would escape the workspace or hide the directory", () => {
      for (const name of ["", ".", "..", ".hidden", "a/b", "a\\b", "with space"]) {
        assert.throws(() => assertValidCorpusName(name), ConfigError, `should reject ${name}`);
      }
    });
  });

  describe("initProjectWorkspace", () => {
    it("creates .graphdog with a corpora directory", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      assert.equal(workspace.scope, "project");
      assert.ok(workspace.root.endsWith(WORKSPACE_DIRNAME));
      assert.deepEqual(await listCorpusNames(workspace), []);
    });

    it("writes a .gitignore that keeps the config but not the built index", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      const ignore = await readFile(join(workspace.root, ".gitignore"), "utf8");
      assert.match(ignore, /corpus\.sqlite3/);
      assert.doesNotMatch(ignore, /graphdog\.json/, "the config is meant to be committed");
    });

    it("is idempotent", async () => {
      const project = await freshProject();
      await initProjectWorkspace(project);
      await assert.doesNotReject(() => initProjectWorkspace(project));
    });
  });

  describe("findProjectWorkspace", () => {
    it("finds a workspace in the current directory", async () => {
      const project = await freshProject();
      await initProjectWorkspace(project);
      const found = await findProjectWorkspace(project);
      assert.equal(found?.scope, "project");
    });

    it("walks upward from a subdirectory", async () => {
      const project = await freshProject();
      await initProjectWorkspace(project);
      const nested = join(project, "src", "deep", "here");
      await mkdir(nested, { recursive: true });
      const found = await findProjectWorkspace(nested);
      assert.equal(found?.root, join(project, WORKSPACE_DIRNAME));
    });

    it("returns null when there is none", async () => {
      const bare = await freshProject();
      assert.equal(await findProjectWorkspace(bare), null);
    });
  });

  describe("homeWorkspace", () => {
    it("honours GRAPHDOG_HOME", () => {
      assert.equal(homeWorkspace().root, join(root, "fake-home"));
      assert.equal(homeWorkspace().scope, "home");
    });
  });

  describe("visibleWorkspaces", () => {
    it("puts the project workspace before the home one", async () => {
      const project = await freshProject();
      await initProjectWorkspace(project);
      const workspaces = await visibleWorkspaces(project);
      assert.equal(workspaces[0]?.scope, "project");
      assert.equal(workspaces[1]?.scope, "home");
    });

    it("returns the home workspace alone when there is no project", async () => {
      const bare = await freshProject();
      const workspaces = await visibleWorkspaces(bare);
      assert.deepEqual(workspaces.map((w) => w.scope), ["home"]);
    });
  });

  describe("resolveCorpus", () => {
    it("uses the only corpus when no name is given", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "only"), defaultCorpusConfig("only"));

      const resolved = await resolveCorpus(undefined, project);
      assert.equal(resolved.name, "only");
      assert.equal(resolved.storePath, corpusStorePath(workspace, "only"));
    });

    it("refuses to guess when several exist", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "one"), defaultCorpusConfig("one"));
      await saveCorpusConfig(corpusConfigPath(workspace, "two"), defaultCorpusConfig("two"));

      await assert.rejects(
        () => resolveCorpus(undefined, project),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /--corpus/);
          assert.deepEqual(error.details["available"], ["one", "two"]);
          return true;
        },
      );
    });

    it("finds a corpus by name", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "two"), defaultCorpusConfig("two"));
      assert.equal((await resolveCorpus("two", project)).name, "two");
    });

    it("lists what is available when a name is wrong", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      await saveCorpusConfig(corpusConfigPath(workspace, "real"), defaultCorpusConfig("real"));

      await assert.rejects(
        () => resolveCorpus("typo", project),
        (error: unknown) => {
          assert.ok(error instanceof CorpusNotFoundError);
          assert.deepEqual(error.details["available"], ["real"]);
          return true;
        },
      );
    });

    it("points at init when there is nothing at all", async () => {
      const bare = await freshProject();
      await assert.rejects(
        () => resolveCorpus(undefined, bare),
        (error: unknown) => {
          assert.ok(error instanceof CorpusNotFoundError);
          assert.match(error.message, /init/);
          return true;
        },
      );
    });
  });

  describe("resolveSourceUri", () => {
    it("resolves a relative source against the project, not the process cwd", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      assert.equal(resolveSourceUri(workspace, "./docs"), join(project, "docs"));
    });

    it("leaves an absolute path alone", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      assert.equal(resolveSourceUri(workspace, "/var/data"), "/var/data");
    });
  });

  describe("listCorpusNames", () => {
    it("returns names in a stable order", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      for (const name of ["zeta", "alpha", "mid"]) {
        await saveCorpusConfig(corpusConfigPath(workspace, name), defaultCorpusConfig(name));
      }
      assert.deepEqual(await listCorpusNames(workspace), ["alpha", "mid", "zeta"]);
    });

    it("ignores a directory with no config", async () => {
      const project = await freshProject();
      const workspace = await initProjectWorkspace(project);
      await mkdir(join(workspace.root, "corpora", "half-made"), { recursive: true });
      assert.deepEqual(await listCorpusNames(workspace), []);
    });

    it("returns nothing for a workspace that does not exist", async () => {
      assert.deepEqual(await listCorpusNames({ root: join(root, "nope"), scope: "home" }), []);
    });
  });
});
