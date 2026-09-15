/**
 * Wiring for `export` and `import`.
 *
 * Separate from `corpus-context.ts` because neither operation needs a
 * searchable corpus. Export reads the store and never the embedding model --
 * which for a semantic corpus would mean loading, or downloading, a model just
 * to copy a file -- and import has no corpus open at all until it has finished
 * verifying one.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { VERSION } from "../version.ts";
import { ArchiveError, ConfigError, ConflictError, NotFoundError } from "../domain/errors.ts";
import { ARCHIVE_ENTRIES, ARCHIVE_EXTENSION } from "../domain/model/corpus-manifest.ts";
import { WarningCode } from "../application/dto/contracts.ts";
import type { Logger } from "../application/ports/system.ts";
import type { ArchiveOutcome } from "../application/usecase/archive-checks.ts";
import { exportCorpus } from "../application/usecase/export-corpus.ts";
import { importCorpus } from "../application/usecase/import-corpus.ts";
import { DEFAULT_MAX_EXPANDED_BYTES, GzipArchiveCodec } from "../infrastructure/archive/gzip-archive-codec.ts";
import { WorkspaceCorpusInstaller } from "../infrastructure/config/corpus-installer.ts";
import { formatCorpusConfig, parseCorpusConfig } from "../infrastructure/config/corpus-config-file.ts";
import {
  findProjectWorkspace,
  homeWorkspace,
  listCorpusNames,
  readCorpusConfig,
  resolveCorpus,
  visibleWorkspaces,
  type Workspace,
  type WorkspaceScope,
} from "../infrastructure/config/workspace.ts";
import { SqliteCorpusFileInspector } from "../infrastructure/persistence/sqlite/corpus-file-inspector.ts";
import { SqliteCorpusStore } from "../infrastructure/persistence/sqlite/sqlite-corpus-store.ts";
import { sha256Hasher, systemClock } from "../infrastructure/system-adapters.ts";

export interface ExportArchiveOptions {
  readonly corpus?: string;
  readonly cwd?: string;
  /** Where to write the archive. Defaults to `<corpus>.gdog` in `cwd`. */
  readonly out?: string;
  readonly overwrite?: boolean;
  readonly logger?: Logger;
}

export async function exportCorpusArchive(options: ExportArchiveOptions = {}): Promise<ArchiveOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = await resolveCorpus(options.corpus, cwd);
  const config = await readCorpusConfig(resolved);
  const store = await SqliteCorpusStore.open(resolved.storePath);

  try {
    return await exportCorpus(
      {
        archivePath: resolve(cwd, options.out ?? `${resolved.name}${ARCHIVE_EXTENSION}`),
        overwrite: options.overwrite === true,
      },
      {
        config,
        codec: new GzipArchiveCodec(),
        inspector: new SqliteCorpusFileInspector(),
        hasher: sha256Hasher,
        clock: systemClock,
        version: VERSION,
        snapshot: () => snapshotOf(store),
        serializeConfig: formatCorpusConfig,
        writeArchive: writeArchiveFile,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
    );
  } finally {
    store.close();
  }
}

export interface ImportArchiveOptions {
  readonly archivePath: string;
  /** Install under this name instead of the archive's own. */
  readonly name?: string;
  readonly replace?: boolean;
  /**
   * Which workspace receives the corpus. Home by default: that is where
   * corpora shared across projects live, and an imported artifact is one.
   */
  readonly scope?: WorkspaceScope;
  readonly cwd?: string;
  readonly logger?: Logger;
}

export async function importCorpusArchive(options: ImportArchiveOptions): Promise<ArchiveOutcome> {
  const cwd = options.cwd ?? process.cwd();
  const workspace = await targetWorkspace(options.scope ?? "home", cwd);

  const outcome = await importCorpus(
    {
      archivePath: resolve(cwd, options.archivePath),
      ...(options.name === undefined ? {} : { name: options.name }),
      replace: options.replace === true,
    },
    {
      codec: new GzipArchiveCodec(),
      hasher: sha256Hasher,
      inspector: new SqliteCorpusFileInspector(),
      installer: new WorkspaceCorpusInstaller(workspace),
      readArchive: readArchiveFile,
      parseConfig: (input) => parseCorpusConfig(input, ARCHIVE_ENTRIES.config),
      serializeConfig: formatCorpusConfig,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
  );

  const shadow = await shadowingWorkspace(outcome.corpus, workspace, cwd);
  if (shadow === null) return outcome;
  return {
    ...outcome,
    warnings: [
      ...outcome.warnings,
      {
        code: WarningCode.CORPUS_SHADOWED,
        message:
          `a corpus named "${outcome.corpus}" in the ${shadow.scope} workspace takes precedence from ` +
          `here, so this import is not what --corpus ${outcome.corpus} opens; import it with --as ` +
          `to give it a name of its own`,
        details: { shadowed_by: shadow.root },
      },
    ],
  };
}

async function targetWorkspace(scope: WorkspaceScope, cwd: string): Promise<Workspace> {
  if (scope === "home") return homeWorkspace();
  const project = await findProjectWorkspace(cwd);
  if (project === null) {
    throw new ConfigError("there is no project workspace here to import into", {
      hint: "run 'graphdog init' first, or leave out --project to import into the home workspace",
    });
  }
  return project;
}

/**
 * The workspace whose same-named corpus would be opened instead of the import.
 *
 * Name resolution takes the project workspace before home, so a home import
 * that shares a name with a project corpus is installed correctly and yet is
 * not what `--corpus <name>` reaches from inside that project. Silently
 * accepting that would make the import look like it did nothing.
 */
async function shadowingWorkspace(name: string, installedInto: Workspace, cwd: string): Promise<Workspace | null> {
  for (const workspace of await visibleWorkspaces(cwd)) {
    if (!(await listCorpusNames(workspace)).includes(name)) continue;
    return workspace.root === installedInto.root ? null : workspace;
  }
  return null;
}

/** A consistent copy of the store, taken without blocking readers. */
async function snapshotOf(store: SqliteCorpusStore): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "graphdog-export-"));
  try {
    const path = join(directory, "snapshot.sqlite3");
    store.snapshotTo(path);
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Write an archive so that no reader ever sees half of one.
 *
 * Written beside the destination and renamed into place: a download, a copy or
 * a CI upload that picks the file up mid-write gets either nothing or the
 * whole archive.
 */
async function writeArchiveFile(path: string, data: Uint8Array, overwrite: boolean): Promise<void> {
  if (!overwrite && (await exists(path))) {
    throw new ConflictError(`${path} already exists`, { path, hint: "pass --force to overwrite it" });
  }
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial-${randomUUID()}`;
  try {
    await writeFile(partial, data);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

async function readArchiveFile(path: string): Promise<Uint8Array> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new ArchiveError(`not a file: ${path}`, { path });
    size = info.size;
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new NotFoundError(`archive not found: ${path}`, { path });
  }
  // Checked before reading: the whole archive is held in memory, so the size
  // is refused while that is still cheap.
  if (size > DEFAULT_MAX_EXPANDED_BYTES) {
    throw new ArchiveError(`archive is ${size} bytes, over the ${DEFAULT_MAX_EXPANDED_BYTES}-byte limit`, {
      path,
      limit: DEFAULT_MAX_EXPANDED_BYTES,
    });
  }
  return new Uint8Array(await readFile(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
