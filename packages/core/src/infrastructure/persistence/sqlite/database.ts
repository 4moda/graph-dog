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

/**
 * Open a SQLite database, preferring the built-in driver.
 *
 * The pragmas are chosen for a workload of one writer during a build and many
 * short readers afterwards: WAL so a search is never blocked by a build, and
 * `synchronous=NORMAL` because a corpus is derived data that can be rebuilt,
 * which makes full fsync durability a poor trade for build speed.
 */
export async function openDatabase(path: string): Promise<Database> {
  const database = await openDriver(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}

async function openDriver(path: string): Promise<Database> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const handle = new DatabaseSync(path);
    return {
      exec: (sql) => handle.exec(sql),
      prepare: (sql) => handle.prepare(sql) as unknown as Statement,
      close: () => handle.close(),
    };
  } catch (builtinError) {
    try {
      // @ts-expect-error -- optional dependency, resolved only if installed.
      const module = await import("better-sqlite3");
      const BetterSqlite3 = (module.default ?? module) as new (file: string) => {
        exec(sql: string): void;
        prepare(sql: string): Statement;
        close(): void;
      };
      const handle = new BetterSqlite3(path);
      return {
        exec: (sql) => handle.exec(sql),
        prepare: (sql) => handle.prepare(sql),
        close: () => handle.close(),
      };
    } catch {
      throw new ConfigError(
        "no SQLite driver available: Node 22.5+ provides node:sqlite, " +
          "otherwise install better-sqlite3",
        { node_version: process.version, cause: String(builtinError) },
      );
    }
  }
}
