/**
 * Thin adapter over the SQLite driver.
 *
 * Node 22.5+ ships `node:sqlite`, so the default install needs no native
 * module to compile -- which matters a great deal for an npm package an agent
 * is expected to run through `npx`. `better-sqlite3` is accepted as a fallback
 * for anyone on a runtime without it, behind the same tiny interface.
 */

import { ConfigError } from "../../../domain/errors.ts";

export type SqlValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, SqlValue>;

export interface Statement {
  run(...params: SqlValue[]): void;
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

export interface OpenDatabaseOptions {
  /**
   * Open without write access, and without the WAL pragma -- which would
   * itself write. Used to examine a database from an archive before it is
   * trusted.
   */
  readonly readOnly?: boolean;
}

/**
 * Open a SQLite database, preferring the built-in driver.
 *
 * The pragmas are chosen for a workload of one writer during a build and many
 * short readers afterwards: WAL so a search is never blocked by a build, and
 * `synchronous=NORMAL` because a corpus is derived data that can be rebuilt,
 * which makes full fsync durability a poor trade for build speed.
 */
export async function openDatabase(path: string, options: OpenDatabaseOptions = {}): Promise<Database> {
  const readOnly = options.readOnly === true;
  const database = await openDriver(path, readOnly);
  try {
    if (readOnly) {
      // Functions reachable from the schema -- in views, triggers, CHECK
      // constraints, generated columns -- are limited to side-effect-free
      // ones. A read-only database is one that may have come from elsewhere.
      database.exec("PRAGMA trusted_schema = OFF");
      database.exec("PRAGMA busy_timeout = 5000");
      return database;
    }
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    return database;
  } catch (error) {
    // The first statement is where SQLite notices a file is not a database.
    // Close the handle rather than leak it; on Windows a leaked handle also
    // stops the file from being deleted.
    database.close();
    throw error;
  }
}

async function openDriver(path: string, readOnly: boolean): Promise<Database> {
  // Only a failure to *load* the built-in driver falls back to better-sqlite3.
  // A failure to open the file is the file's problem, and reporting it as "no
  // SQLite driver available" would send someone to fix the wrong thing.
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (builtinError) {
    return openBetterSqlite(path, readOnly, builtinError);
  }
  const handle = new DatabaseSync(path, { readOnly });
  return {
    exec: (sql) => handle.exec(sql),
    prepare: (sql) => handle.prepare(sql) as unknown as Statement,
    close: () => handle.close(),
  };
}

async function openBetterSqlite(path: string, readOnly: boolean, builtinError: unknown): Promise<Database> {
  let BetterSqlite3: new (
    file: string,
    options?: { readonly?: boolean },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  };
  try {
    // @ts-expect-error -- optional dependency, resolved only if installed.
    const module = await import("better-sqlite3");
    BetterSqlite3 = module.default ?? module;
  } catch {
    throw new ConfigError(
      "no SQLite driver available: Node 22.5+ provides node:sqlite, " +
        "otherwise install better-sqlite3",
      { node_version: process.version, cause: String(builtinError) },
    );
  }
  const handle = new BetterSqlite3(path, { readonly: readOnly });
  return {
    exec: (sql) => handle.exec(sql),
    prepare: (sql) => handle.prepare(sql),
    close: () => handle.close(),
  };
}
