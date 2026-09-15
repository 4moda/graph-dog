/**
 * Putting an imported corpus into a workspace.
 *
 * The corpus is written to a staging directory beside `corpora/` and moved
 * into place with a single rename, so a crash, a full disk or a failure
 * partway through leaves either the previous state or the complete new corpus
 * -- never a directory holding a config and half a database, which `list`
 * would happily report as a corpus.
 *
 * File names are this module's own constants, never names taken from the
 * archive: an archive's contents do not get to choose where anything lands.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ConflictError } from "../../domain/errors.ts";
import { CORPUS_META_KEYS } from "../../application/corpus-meta.ts";
import type { CorpusInstaller, InstallRequest, InstallResult } from "../../application/ports/archive.ts";
import { openDatabase } from "../persistence/sqlite/database.ts";
import { CORPUS_FILENAME } from "../persistence/sqlite/schema.ts";
import { CONFIG_FILENAME } from "./corpus-config-file.ts";
import { assertValidCorpusName, corporaDir, corpusDir, type Workspace } from "./workspace.ts";

export class WorkspaceCorpusInstaller implements CorpusInstaller {
  readonly #workspace: Workspace;

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async install(request: InstallRequest): Promise<InstallResult> {
    assertValidCorpusName(request.name);
    const target = corpusDir(this.#workspace, request.name);
    const existed = await exists(target);

    if (existed && !request.replace) {
      throw new ConflictError(
        `corpus "${request.name}" already exists in the ${this.#workspace.scope} workspace`,
        {
          path: target,
          hint: "pass --replace to overwrite it, or --as <name> to import it under another name",
        },
      );
    }

    await mkdir(corporaDir(this.#workspace), { recursive: true });
    // Staged outside `corpora/`, so a half-written import is never listed as a
    // corpus even for the moment it exists.
    const staging = join(this.#workspace.root, `.import-${randomUUID()}`);
    await mkdir(staging);

    try {
      const databasePath = join(staging, CORPUS_FILENAME);
      await writeFile(databasePath, request.database);
      await recordName(databasePath, request.name);
      await writeFile(join(staging, CONFIG_FILENAME), request.config, "utf8");

      if (existed) {
        // Move the old corpus aside rather than deleting it first, so a failed
        // swap can put it back.
        const retired = join(this.#workspace.root, `.replaced-${randomUUID()}`);
        await rename(target, retired);
        try {
          await renameInto(staging, target, request.name);
        } catch (error) {
          await rename(retired, target);
          throw error;
        }
        await rm(retired, { recursive: true, force: true });
      } else {
        await renameInto(staging, target, request.name);
      }

      return { directory: target, scope: this.#workspace.scope, replaced: existed };
    } finally {
      // A no-op after a successful rename; otherwise it removes the debris.
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Record the name the corpus is installed under.
 *
 * `status` reports the stored name, so a corpus imported with `--as` would
 * otherwise describe itself by the name it had on another machine.
 */
async function recordName(path: string, name: string): Promise<void> {
  const db = await openDatabase(path);
  try {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(CORPUS_META_KEYS.corpusName, name);
  } finally {
    db.close();
  }
}

/** Rename, reporting a lost race with a concurrent import as the conflict it is. */
async function renameInto(from: string, to: string, name: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      throw new ConflictError(`corpus "${name}" was created by something else during the import`, {
        path: to,
      });
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
