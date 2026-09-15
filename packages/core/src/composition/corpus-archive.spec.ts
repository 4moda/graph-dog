import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  ArchiveError,
  ConfigError,
  ConflictError,
  IncompatibleCorpusError,
  NotFoundError,
} from "../domain/errors.ts";
import { defaultCorpusConfig } from "../application/config.ts";
import { CORPUS_META_KEYS } from "../application/corpus-meta.ts";
import { WarningCode } from "../application/dto/contracts.ts";
import { buildCorpus } from "../application/usecase/build-corpus.ts";
import { searchCorpus } from "../application/usecase/search-corpus.ts";
import { saveCorpusConfig } from "../infrastructure/config/corpus-config-file.ts";
import {
  corpusConfigPath,
  homeWorkspace,
  initProjectWorkspace,
  listCorpusNames,
} from "../infrastructure/config/workspace.ts";
import { normalizeSourceSpec } from "../infrastructure/source/source-reader-factory.ts";
import { openCorpus } from "./corpus-context.ts";
import { exportCorpusArchive, importCorpusArchive } from "./corpus-archive.ts";

let root: string;
const originalHome = process.env["GRAPHDOG_HOME"];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "graphdog-archive-"));
});
after(async () => {
  if (originalHome === undefined) delete process.env["GRAPHDOG_HOME"];
  else process.env["GRAPHDOG_HOME"] = originalHome;
  await rm(root, { recursive: true, force: true });
});

let counter = 0;

/** A directory with no `.graphdog` anywhere above it, and a private home. */
async function elsewhere(): Promise<string> {
  counter += 1;
  const directory = join(root, `elsewhere-${counter}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * A project with one corpus, optionally built, and a fresh home workspace.
 *
 * Built through the real use cases, so the archive under test is what a user's
 * `graphdog build` would have produced.
 */
async function project(options: { name?: string; build?: boolean } = {}): Promise<string> {
  counter += 1;
  const name = options.name ?? "docs";
  const directory = join(root, `project-${counter}`);
  process.env["GRAPHDOG_HOME"] = join(root, `home-${counter}`);

  await mkdir(join(directory, "docs"), { recursive: true });
  await writeFile(
    join(directory, "docs", "keys.md"),
    "# Key Management\n\nPublic keys are published at the JWKS endpoint.\n",
    "utf8",
  );
  await writeFile(
    join(directory, "docs", "token.md"),
    "# Access Token\n\nTokens are JWT values signed with ES256. See [keys](keys.md).\n",
    "utf8",
  );

  const workspace = await initProjectWorkspace(directory);
  await saveCorpusConfig(corpusConfigPath(workspace, name), {
    ...defaultCorpusConfig(name),
    sources: [normalizeSourceSpec({ id: "docs", uri: "./docs" })],
  });

  if (options.build !== false) {
    const context = await openCorpus({ corpus: name, cwd: directory });
    try {
      await buildCorpus(
        { full: true },
        {
          store: context.store,
          config: context.config,
          sources: context.sources,
          extractors: context.extractors,
          embedding: context.embedding,
          clock: context.clock,
          hasher: context.hasher,
          readFile: context.readFile,
          logger: context.logger,
        },
      );
    } finally {
      context.close();
    }
  }
  return directory;
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

describe("composition/corpus-archive", () => {
  describe("exportCorpusArchive", () => {
    it("writes <corpus>.gdog into the working directory by default", async () => {
      const cwd = await project();
      const outcome = await exportCorpusArchive({ cwd });
      assert.equal(outcome.archivePath, join(cwd, "docs.gdog"));

      const file = new Uint8Array(await readFile(outcome.archivePath));
      assert.equal(file.length, outcome.bytes);
      assert.equal(sha256(file), outcome.checksum, "the reported checksum is of the file on disk");
      assert.deepEqual([file[0], file[1]], [0x1f, 0x8b], "a gzip file, inspectable with tar -tzf");
    });

    it("describes the built corpus in the manifest", async () => {
      const outcome = await exportCorpusArchive({ cwd: await project() });
      assert.equal(outcome.manifest.corpus, "docs");
      assert.equal(outcome.manifest.counts.documents, 2);
      assert.match(outcome.manifest.identity.embeddingId, /^hash/);
      assert.deepEqual(
        outcome.manifest.sources.map((source) => source.id),
        ["docs"],
      );
    });

    it("writes to --out, creating the directories it needs", async () => {
      const cwd = await project();
      const outcome = await exportCorpusArchive({ cwd, out: "dist/archives/docs.gdog" });
      assert.equal(outcome.archivePath, join(cwd, "dist", "archives", "docs.gdog"));
      assert.ok((await readFile(outcome.archivePath)).length > 0);
    });

    it("refuses to replace an existing file unless told to", async () => {
      const cwd = await project();
      await exportCorpusArchive({ cwd });
      await assert.rejects(() => exportCorpusArchive({ cwd }), ConflictError);
      await assert.doesNotReject(() => exportCorpusArchive({ cwd, overwrite: true }));
    });

    it("refuses a corpus that has never been built", async () => {
      const cwd = await project({ build: false });
      await assert.rejects(() => exportCorpusArchive({ cwd }), IncompatibleCorpusError);
    });
  });

  describe("importCorpusArchive", () => {
    it("installs into the home workspace, where it is searchable with no sources present", async () => {
      const source = await project();
      const exported = await exportCorpusArchive({ cwd: source });
      // The documents are gone: whatever is found below came out of the archive.
      await rm(join(source, "docs"), { recursive: true, force: true });

      const cwd = await elsewhere();
      const outcome = await importCorpusArchive({ archivePath: exported.archivePath, cwd });
      assert.equal(outcome.destination?.scope, "home");
      assert.deepEqual(await listCorpusNames(homeWorkspace()), ["docs"]);

      const context = await openCorpus({ corpus: "docs", cwd });
      try {
        const result = await searchCorpus(
          { query: "JWKS" },
          {
            store: context.store,
            config: context.config,
            embedding: context.embedding,
            freshness: context.freshness(),
            logger: context.logger,
          },
        );
        assert.equal(result.hits[0]?.ref, "docs/keys.md");
      } finally {
        context.close();
      }
    });

    it("installs under another name, and the corpus reports that name", async () => {
      const exported = await exportCorpusArchive({ cwd: await project() });
      const cwd = await elsewhere();
      const outcome = await importCorpusArchive({ archivePath: exported.archivePath, name: "team-docs", cwd });
      assert.equal(outcome.corpus, "team-docs");

      const context = await openCorpus({ corpus: "team-docs", cwd });
      try {
        assert.equal(context.config.name, "team-docs");
        assert.equal(context.store.meta.get(CORPUS_META_KEYS.corpusName), "team-docs");
      } finally {
        context.close();
      }
    });

    it("refuses to replace an existing corpus unless asked", async () => {
      const exported = await exportCorpusArchive({ cwd: await project() });
      const cwd = await elsewhere();
      await importCorpusArchive({ archivePath: exported.archivePath, cwd });
      await assert.rejects(() => importCorpusArchive({ archivePath: exported.archivePath, cwd }), ConflictError);

      const replaced = await importCorpusArchive({ archivePath: exported.archivePath, cwd, replace: true });
      assert.equal(replaced.destination?.replaced, true);
    });

    it("installs into the project workspace when asked", async () => {
      const exported = await exportCorpusArchive({ cwd: await project() });
      const target = await elsewhere();
      const workspace = await initProjectWorkspace(target);

      const outcome = await importCorpusArchive({ archivePath: exported.archivePath, cwd: target, scope: "project" });
      assert.equal(outcome.destination?.scope, "project");
      assert.deepEqual(await listCorpusNames(workspace), ["docs"]);
    });

    it("refuses a project import where there is no project workspace", async () => {
      const exported = await exportCorpusArchive({ cwd: await project() });
      await assert.rejects(
        async () => importCorpusArchive({ archivePath: exported.archivePath, cwd: await elsewhere(), scope: "project" }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /no project workspace/);
          return true;
        },
      );
    });

    it("warns when a project corpus of the same name would be opened instead", async () => {
      const cwd = await project();
      const exported = await exportCorpusArchive({ cwd });
      // Imported into home from inside the project that already has a "docs".
      const outcome = await importCorpusArchive({ archivePath: exported.archivePath, cwd });
      assert.ok(outcome.warnings.some((warning) => warning.code === WarningCode.CORPUS_SHADOWED));
    });

    it("does not warn about shadowing when nothing shadows the import", async () => {
      const exported = await exportCorpusArchive({ cwd: await project() });
      const outcome = await importCorpusArchive({ archivePath: exported.archivePath, cwd: await elsewhere() });
      assert.ok(!outcome.warnings.some((warning) => warning.code === WarningCode.CORPUS_SHADOWED));
    });

    it("reports a missing archive as not found", async () => {
      await project();
      await assert.rejects(
        async () => importCorpusArchive({ archivePath: "nope.gdog", cwd: await elsewhere() }),
        NotFoundError,
      );
    });

    it("refuses a damaged archive and installs nothing", async () => {
      const exported = await exportCorpusArchive({ cwd: await project() });
      const bytes = new Uint8Array(await readFile(exported.archivePath));
      const middle = Math.floor(bytes.length / 2);
      bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
      await writeFile(exported.archivePath, bytes);

      await assert.rejects(
        async () => importCorpusArchive({ archivePath: exported.archivePath, cwd: await elsewhere() }),
        ArchiveError,
      );
      assert.deepEqual(await listCorpusNames(homeWorkspace()), []);
    });
  });
});
