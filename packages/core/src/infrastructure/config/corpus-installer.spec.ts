import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { ConfigError, ConflictError } from "../../domain/errors.ts";
import { CORPUS_META_KEYS } from "../../application/corpus-meta.ts";
import { SqliteCorpusStore } from "../persistence/sqlite/sqlite-corpus-store.ts";
import { CORPUS_FILENAME } from "../persistence/sqlite/schema.ts";
import { CONFIG_FILENAME } from "./corpus-config-file.ts";
import { WorkspaceCorpusInstaller } from "./corpus-installer.ts";
import { corpusDir, listCorpusNames, type Workspace } from "./workspace.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-installer-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;

/** A workspace that does not exist yet, as a fresh home workspace does not. */
function workspace(): Workspace {
  counter += 1;
  return { root: join(root, `ws-${counter}`, ".graphdog"), scope: "home" };
}

/** Snapshot bytes of a real corpus database, as an import receives them. */
async function databaseBytes(): Promise<Uint8Array> {
  counter += 1;
  const store = await SqliteCorpusStore.open(join(root, `source-${counter}.sqlite3`));
  try {
    store.meta.set(CORPUS_META_KEYS.corpusName, "docs");
    const out = join(root, `snapshot-${counter}.sqlite3`);
    store.snapshotTo(out);
    return new Uint8Array(await readFile(out));
  } finally {
    store.close();
  }
}

const config = (name: string, note = ""): string =>
  `${JSON.stringify({ version: 1, name, description: note }, null, 2)}\n`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("infrastructure/config/corpus-installer", () => {
  it("installs the database and config under corpora/<name>, creating the workspace", async () => {
    const target = workspace();
    const result = await new WorkspaceCorpusInstaller(target).install({
      name: "docs",
      config: config("docs"),
      database: await databaseBytes(),
      replace: false,
    });

    assert.equal(result.directory, corpusDir(target, "docs"));
    assert.equal(result.scope, "home");
    assert.equal(result.replaced, false);
    assert.equal(await readFile(join(result.directory, CONFIG_FILENAME), "utf8"), config("docs"));
    assert.ok(await exists(join(result.directory, CORPUS_FILENAME)));
    assert.deepEqual(await listCorpusNames(target), ["docs"]);
  });

  it("records the installed name in the database, so status reports it", async () => {
    const result = await new WorkspaceCorpusInstaller(workspace()).install({
      name: "team-docs",
      config: config("team-docs"),
      database: await databaseBytes(),
      replace: false,
    });
    const store = await SqliteCorpusStore.open(join(result.directory, CORPUS_FILENAME));
    assert.equal(store.meta.get(CORPUS_META_KEYS.corpusName), "team-docs");
    store.close();
  });

  it("refuses to replace an existing corpus unless asked, leaving it untouched", async () => {
    const target = workspace();
    const installer = new WorkspaceCorpusInstaller(target);
    await installer.install({ name: "docs", config: config("docs", "first"), database: await databaseBytes(), replace: false });

    await assert.rejects(
      async () =>
        installer.install({ name: "docs", config: config("docs", "second"), database: await databaseBytes(), replace: false }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.match(error.message, /already exists in the home workspace/);
        assert.match(String(error.details["hint"]), /--replace/);
        return true;
      },
    );
    assert.equal(
      await readFile(join(corpusDir(target, "docs"), CONFIG_FILENAME), "utf8"),
      config("docs", "first"),
    );
  });

  it("replaces an existing corpus when asked, and says it did", async () => {
    const target = workspace();
    const installer = new WorkspaceCorpusInstaller(target);
    await installer.install({ name: "docs", config: config("docs", "first"), database: await databaseBytes(), replace: false });
    const result = await installer.install({
      name: "docs",
      config: config("docs", "second"),
      database: await databaseBytes(),
      replace: true,
    });
    assert.equal(result.replaced, true);
    assert.equal(await readFile(join(result.directory, CONFIG_FILENAME), "utf8"), config("docs", "second"));
  });

  it("leaves no staging or retired directories behind", async () => {
    const target = workspace();
    const installer = new WorkspaceCorpusInstaller(target);
    await installer.install({ name: "docs", config: config("docs"), database: await databaseBytes(), replace: false });
    await installer.install({ name: "docs", config: config("docs"), database: await databaseBytes(), replace: true });
    assert.deepEqual(await readdir(target.root), ["corpora"]);
  });

  it("refuses an unsafe name before creating anything", async () => {
    const target = workspace();
    await assert.rejects(
      async () =>
        new WorkspaceCorpusInstaller(target).install({
          name: "../escape",
          config: config("x"),
          database: await databaseBytes(),
          replace: false,
        }),
      ConfigError,
    );
    assert.equal(await exists(target.root), false);
  });

  it("cleans up after a database that cannot be written, and installs nothing", async () => {
    const target = workspace();
    await assert.rejects(() =>
      new WorkspaceCorpusInstaller(target).install({
        name: "docs",
        config: config("docs"),
        database: new TextEncoder().encode("not a database ".repeat(64)),
        replace: false,
      }),
    );
    assert.deepEqual(await readdir(target.root), ["corpora"]);
    assert.deepEqual(await listCorpusNames(target), []);
  });
});
