import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FIXED_CLOCK,
  JsonArchiveCodec,
  StubInspector,
  fixtureHasher,
} from "../../__fixtures__/archive-fakes.ts";
import { ArchiveError, IncompatibleCorpusError } from "../../domain/errors.ts";
import { CHUNKING_SCHEMA_VERSION, SCHEMA_VERSION } from "../../domain/model/corpus-identity.ts";
import { ARCHIVE_ENTRIES, verifyArchive } from "../../domain/model/corpus-manifest.ts";
import { chunkingFingerprint } from "../../domain/service/chunker.ts";
import { defaultCorpusConfig, type CorpusConfig } from "../config.ts";
import { WarningCode } from "../dto/contracts.ts";
import type { DatabaseInspection } from "../ports/archive.ts";
import { exportCorpus, type ExportDependencies } from "./export-corpus.ts";

const config = defaultCorpusConfig("docs");
const FINGERPRINT = chunkingFingerprint(fixtureHasher.hashText, config.chunking);
const DATABASE = Uint8Array.from([0x53, 0x51, 0x4c, 0x00, 0x01, 0xff]);
const codec = new JsonArchiveCodec();

function inspection(overrides: Partial<DatabaseInspection> = {}): DatabaseInspection {
  return {
    foreignObjects: [],
    identity: {
      schemaVersion: SCHEMA_VERSION,
      chunkingSchemaVersion: CHUNKING_SCHEMA_VERSION,
      embeddingId: "hash-v1:d256",
      chunkingFingerprint: FINGERPRINT,
    },
    builtAt: "2026-09-14T00:00:00.000Z",
    counts: { documents: 2, chunks: 5, nodes: 3, edges: 2 },
    sources: [
      { id: "docs", revision: null },
      { id: "spec", revision: "a1b2c3d4" },
    ],
    failures: 0,
    ...overrides,
  };
}

function setup(
  options: { inspection?: DatabaseInspection; config?: CorpusConfig } = {},
): {
  dependencies: ExportDependencies;
  written: Array<{ path: string; data: Uint8Array; overwrite: boolean }>;
  inspector: StubInspector;
  snapshots: () => number;
} {
  const written: Array<{ path: string; data: Uint8Array; overwrite: boolean }> = [];
  const inspector = new StubInspector(options.inspection ?? inspection());
  let snapshots = 0;
  return {
    written,
    inspector,
    snapshots: () => snapshots,
    dependencies: {
      config: options.config ?? config,
      codec,
      inspector,
      hasher: fixtureHasher,
      clock: FIXED_CLOCK,
      version: "9.9.9",
      snapshot: async () => {
        snapshots += 1;
        return DATABASE;
      },
      serializeConfig: (value) => `${JSON.stringify({ version: 1, name: value.name })}\n`,
      writeArchive: async (path, data, overwrite) => {
        written.push({ path, data, overwrite });
      },
    },
  };
}

async function refuses(
  run: () => Promise<unknown>,
  type: new (...args: never[]) => Error,
  pattern: RegExp,
): Promise<Error> {
  let caught: unknown;
  await assert.rejects(run, (error: unknown) => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof type, `expected ${type.name}, got ${String(caught)}`);
  assert.match((caught as Error).message, pattern);
  return caught as Error;
}

describe("application/usecase/exportCorpus", () => {
  describe("a clean corpus", () => {
    it("writes exactly one archive, to the requested path, refusing to overwrite by default", async () => {
      const { dependencies, written } = setup();
      await exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies);
      assert.equal(written.length, 1);
      assert.equal(written[0]?.path, "/out/docs.gdog");
      assert.equal(written[0]?.overwrite, false);
    });

    it("passes an explicit overwrite through to the writer", async () => {
      const { dependencies, written } = setup();
      await exportCorpus({ archivePath: "/out/docs.gdog", overwrite: true }, dependencies);
      assert.equal(written[0]?.overwrite, true);
    });

    it("produces an archive that passes the importer's own verification", async () => {
      const { dependencies, written } = setup();
      await exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies);
      const verified = verifyArchive(codec.decode(written[0]?.data ?? new Uint8Array(0)), fixtureHasher.hashBytes);
      assert.deepEqual(verified.database, DATABASE);
      assert.equal(new TextDecoder().decode(verified.config), '{"version":1,"name":"docs"}\n');
    });

    it("puts the manifest first, so a listing shows what the archive claims to be", async () => {
      const { dependencies, written } = setup();
      await exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies);
      assert.equal(codec.decode(written[0]?.data ?? new Uint8Array(0))[0]?.name, ARCHIVE_ENTRIES.manifest);
    });

    it("describes the snapshot it ships, not the live store", async () => {
      const { dependencies, inspector, snapshots } = setup();
      const outcome = await exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies);
      assert.equal(snapshots(), 1, "one snapshot, so what is inspected is what is shipped");
      assert.deepEqual(inspector.seen, [DATABASE]);
      assert.deepEqual(outcome.manifest.counts, inspection().counts);
      assert.deepEqual(outcome.manifest.sources, inspection().sources);
      assert.equal(outcome.manifest.builtAt, "2026-09-14T00:00:00.000Z");
      assert.equal(outcome.manifest.identity.chunkingFingerprint, FINGERPRINT);
    });

    it("records when and by what the archive was made", async () => {
      const { dependencies } = setup();
      const outcome = await exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies);
      assert.equal(outcome.manifest.createdAt, FIXED_CLOCK.nowIso());
      assert.equal(outcome.manifest.createdBy, "graphdog 9.9.9");
    });

    it("reports the archive's size and its own checksum, for checking a copy later", async () => {
      const { dependencies, written } = setup();
      const outcome = await exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies);
      const data = written[0]?.data ?? new Uint8Array(0);
      assert.equal(outcome.bytes, data.length);
      assert.equal(outcome.checksum, fixtureHasher.hashBytes(data));
    });

    it("reports an export, with no destination and no warnings", async () => {
      const { dependencies } = setup();
      const outcome = await exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies);
      assert.equal(outcome.operation, "export");
      assert.equal(outcome.corpus, "docs");
      assert.equal(outcome.destination, null);
      assert.deepEqual(outcome.warnings, []);
    });
  });

  describe("refusals, none of which write anything", () => {
    it("refuses a corpus that was never built", async () => {
      const { dependencies, written } = setup({ inspection: inspection({ builtAt: null }) });
      const error = await refuses(
        () => exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies),
        IncompatibleCorpusError,
        /has not been built yet/,
      );
      assert.equal((error as IncompatibleCorpusError).details["remedy"], "graphdog build");
      assert.equal(written.length, 0);
    });

    for (const field of ["schemaVersion", "chunkingSchemaVersion", "embeddingId", "chunkingFingerprint"] as const) {
      it(`refuses a corpus missing ${field}, rather than filling in a default the importer would reject`, async () => {
        const base = inspection();
        const { dependencies, written } = setup({
          inspection: inspection({ identity: { ...base.identity, [field]: null } }),
        });
        await refuses(
          () => exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies),
          IncompatibleCorpusError,
          /does not record its full identity/,
        );
        assert.equal(written.length, 0);
      });
    }

    it("refuses a corpus whose schema this build cannot read", async () => {
      const base = inspection();
      const { dependencies, written } = setup({
        inspection: inspection({ identity: { ...base.identity, schemaVersion: "0" } }),
      });
      await refuses(
        () => exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies),
        IncompatibleCorpusError,
        /schema version 0 is not supported/,
      );
      assert.equal(written.length, 0);
    });

    it("refuses when the config would chunk differently from the index, and says to rebuild", async () => {
      const changed: CorpusConfig = { ...config, chunking: { ...config.chunking, maxChars: config.chunking.maxChars + 1 } };
      const { dependencies, written } = setup({ config: changed });
      const error = await refuses(
        () => exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies),
        IncompatibleCorpusError,
        /rebuild it so the exported config and index agree/,
      );
      assert.equal((error as IncompatibleCorpusError).details["field"], "chunkingFingerprint");
      assert.equal((error as IncompatibleCorpusError).details["remedy"], "graphdog build --full");
      assert.equal(written.length, 0);
    });

    it("refuses a database with triggers or views, which an importer would refuse too", async () => {
      const { dependencies, written } = setup({ inspection: inspection({ foreignObjects: ["trigger:t"] }) });
      await refuses(
        () => exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies),
        ArchiveError,
        /never creates/,
      );
      assert.equal(written.length, 0);
    });
  });

  describe("warnings", () => {
    it("says when the corpus carries files that failed to index", async () => {
      const { dependencies } = setup({ inspection: inspection({ failures: 3 }) });
      const outcome = await exportCorpus({ archivePath: "/out/docs.gdog" }, dependencies);
      const warning = outcome.warnings.find((entry) => entry.code === WarningCode.PARTIAL_INDEX);
      assert.ok(warning, "an importer inherits the gap, so the exporter should hear about it");
      assert.equal(warning.details?.["failures"], 3);
    });
  });
});
