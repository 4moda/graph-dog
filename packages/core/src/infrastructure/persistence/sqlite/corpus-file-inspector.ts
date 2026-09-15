/**
 * Reading a corpus database that did not come from here.
 *
 * The bytes are written to a private temporary file and opened read-only with
 * `trusted_schema` off, so nothing the file's schema defines can run with side
 * effects while it is examined, and the original is never touched. What comes
 * back is facts, not a verdict: the use cases decide what is acceptable. The
 * one exception is a file that is not an intact SQLite corpus at all, which
 * has no facts to report and is refused here.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArchiveError, isGraphDogError } from "../../../domain/errors.ts";
import { compareStrings } from "../../../domain/ordering.ts";
import { CORPUS_META_KEYS } from "../../../application/corpus-meta.ts";
import type { CorpusFileInspector, DatabaseInspection } from "../../../application/ports/archive.ts";
import { openDatabase, type Database } from "./database.ts";
import { CORPUS_FILENAME } from "./schema.ts";

/** How many integrity problems to quote; the first few say everything useful. */
const INTEGRITY_MESSAGES = 5;

export class SqliteCorpusFileInspector implements CorpusFileInspector {
  async inspect(database: Uint8Array): Promise<DatabaseInspection> {
    const directory = await mkdtemp(join(tmpdir(), "graphdog-inspect-"));
    try {
      const path = join(directory, CORPUS_FILENAME);
      await writeFile(path, database);

      let db: Database;
      try {
        db = await openDatabase(path, { readOnly: true });
      } catch (error) {
        throw notACorpus(error);
      }
      try {
        return read(db);
      } catch (error) {
        throw notACorpus(error);
      } finally {
        db.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function read(db: Database): DatabaseInspection {
  // Integrity first: every later query assumes the file is sound, and a
  // corrupt page reported as "no such table" would send someone looking for
  // the wrong problem.
  const problems = db
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => String(Object.values(row)[0] ?? ""));
  if (!(problems.length === 1 && problems[0] === "ok")) {
    throw new ArchiveError(
      `the database failed SQLite's integrity check: ${problems.slice(0, INTEGRITY_MESSAGES).join("; ")}`,
      { problems: problems.slice(0, INTEGRITY_MESSAGES) },
    );
  }

  const foreignObjects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')")
    .all()
    .map((row) => `${String(row["type"])}:${String(row["name"])}`)
    .sort(compareStrings);

  const meta = new Map<string, string>();
  for (const row of db.prepare("SELECT key, value FROM meta").all()) {
    meta.set(String(row["key"]), String(row["value"]));
  }
  const get = (key: string): string | null => meta.get(key) ?? null;

  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return Number(row?.["n"] ?? 0);
  };

  const sources = db
    .prepare("SELECT id, revision FROM sources")
    .all()
    .map((row) => ({
      id: String(row["id"]),
      revision: row["revision"] === null || row["revision"] === undefined ? null : String(row["revision"]),
    }))
    .sort((left, right) => compareStrings(left.id, right.id));

  return {
    foreignObjects,
    identity: {
      schemaVersion: get(CORPUS_META_KEYS.schemaVersion),
      chunkingSchemaVersion: get(CORPUS_META_KEYS.chunkingSchemaVersion),
      embeddingId: get(CORPUS_META_KEYS.embeddingId),
      chunkingFingerprint: get(CORPUS_META_KEYS.chunkingFingerprint),
    },
    builtAt: get(CORPUS_META_KEYS.builtAt),
    counts: {
      documents: count("documents"),
      chunks: count("chunks"),
      nodes: count("nodes"),
      edges: count("edges"),
    },
    sources,
    failures: count("failures"),
  };
}

function notACorpus(error: unknown): Error {
  // An integrity failure is already the precise answer; anything else from the
  // driver means the bytes are not a GraphDog corpus in the first place.
  if (isGraphDogError(error)) return error;
  return new ArchiveError(
    `the database in the archive is not a readable GraphDog corpus: ${error instanceof Error ? error.message : String(error)}`,
    {},
  );
}
