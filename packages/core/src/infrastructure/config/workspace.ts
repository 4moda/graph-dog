/**
 * Where corpora live, and how one is found.
 *
 * Two scopes, resolved in this order:
 *
 * 1. a **project workspace** -- the nearest `.graphdog/` walking up from the
 *    working directory. This is what lets a corpus travel with the repository
 *    it describes, and its config be reviewed in a pull request.
 * 2. a **home workspace** -- `$GRAPHDOG_HOME` or `~/.graphdog`, for corpora
 *    shared across projects and for imported artifacts.
 *
 * The predecessor kept all state in the home directory, keyed off an
 * agent-specific `skill-registry.json`. That made a corpus impossible to commit
 * beside its sources and tied the whole tool to one agent runtime.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import { ConfigError, CorpusNotFoundError } from "../../domain/errors.ts";
import { compareStrings } from "../../domain/ordering.ts";
import type { CorpusConfig } from "../../application/config.ts";
import { CORPUS_FILENAME } from "../persistence/sqlite/schema.ts";
import { CONFIG_FILENAME, loadCorpusConfig, saveCorpusConfig } from "./corpus-config-file.ts";

export const WORKSPACE_DIRNAME = ".graphdog";

export type WorkspaceScope = "project" | "home";

export interface Workspace {
  /** The `.graphdog` directory itself. */
  readonly root: string;
  readonly scope: WorkspaceScope;
}

export function corporaDir(workspace: Workspace): string {
  return join(workspace.root, "corpora");
}

export function corpusDir(workspace: Workspace, name: string): string {
  assertValidCorpusName(name);
  return join(corporaDir(workspace), name);
}

export function corpusConfigPath(workspace: Workspace, name: string): string {
  return join(corpusDir(workspace, name), CONFIG_FILENAME);
}

export function corpusStorePath(workspace: Workspace, name: string): string {
  return join(corpusDir(workspace, name), CORPUS_FILENAME);
}

/**
 * Corpus names become directory names and appear in every response.
 *
 * Rejecting separators and dot-prefixes here is what stops a name from
 * escaping the workspace or colliding with a hidden file.
 */
export function assertValidCorpusName(name: string): void {
  if (name === "" || name.startsWith(".") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new ConfigError(
      `invalid corpus name ${JSON.stringify(name)}: use letters, digits, '-', '_' or '.', ` +
        `starting with a letter or digit`,
    );
  }
}

export function homeWorkspace(): Workspace {
  const override = process.env["GRAPHDOG_HOME"];
  const root = override !== undefined && override !== "" ? resolve(override) : join(homedir(), WORKSPACE_DIRNAME);
  return { root, scope: "home" };
}

/** Nearest `.graphdog` directory at or above `start`. */
export async function findProjectWorkspace(start: string = process.cwd()): Promise<Workspace | null> {
  let current = resolve(start);
  const { root } = parse(current);
  for (;;) {
    const candidate = join(current, WORKSPACE_DIRNAME);
    if (await isDirectory(candidate)) return { root: candidate, scope: "project" };
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Create a project workspace at `root`, idempotently. */
export async function initProjectWorkspace(root: string): Promise<Workspace> {
  const workspace: Workspace = { root: join(resolve(root), WORKSPACE_DIRNAME), scope: "project" };
  await mkdir(corporaDir(workspace), { recursive: true });

  const gitignore = join(workspace.root, ".gitignore");
  if (!(await exists(gitignore))) {
    // The config is the thing worth reviewing and sharing; the built index is
    // derived data that would bloat history and conflict on every rebuild.
    await writeFile(
      gitignore,
      [
        "# GraphDog: commit corpus configs, not built indexes.",
        "corpora/*/corpus.sqlite3",
        "corpora/*/corpus.sqlite3-wal",
        "corpora/*/corpus.sqlite3-shm",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return workspace;
}

export async function listCorpusNames(workspace: Workspace): Promise<string[]> {
  const directory = corporaDir(workspace);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await exists(join(directory, entry.name, CONFIG_FILENAME))) names.push(entry.name);
  }
  return names.sort(compareStrings);
}

/** Every workspace visible from `start`, project first. */
export async function visibleWorkspaces(start: string = process.cwd()): Promise<Workspace[]> {
  const found: Workspace[] = [];
  const project = await findProjectWorkspace(start);
  if (project !== null) found.push(project);
  const home = homeWorkspace();
  if (!found.some((workspace) => workspace.root === home.root)) found.push(home);
  return found;
}

export interface ResolvedCorpus {
  readonly workspace: Workspace;
  readonly name: string;
  readonly configPath: string;
  readonly storePath: string;
}

/**
 * Find the corpus to operate on.
 *
 * With no name given, a single available corpus is used; several is an error
 * rather than a guess, because silently picking one would make every later
 * result wrong in a way the caller cannot see.
 */
export async function resolveCorpus(
  name: string | undefined,
  start: string = process.cwd(),
): Promise<ResolvedCorpus> {
  const workspaces = await visibleWorkspaces(start);

  if (name !== undefined && name !== "") {
    for (const workspace of workspaces) {
      if ((await listCorpusNames(workspace)).includes(name)) {
        return describe(workspace, name);
      }
    }
    const available = new Set<string>();
    for (const workspace of workspaces) {
      for (const found of await listCorpusNames(workspace)) available.add(found);
    }
    throw new CorpusNotFoundError(`corpus "${name}" not found`, {
      searched: workspaces.map((workspace) => workspace.root),
      available: [...available].sort(compareStrings),
    });
  }

  for (const workspace of workspaces) {
    const names = await listCorpusNames(workspace);
    if (names.length === 1) return describe(workspace, names[0] as string);
    if (names.length > 1) {
      throw new ConfigError("several corpora are available; pass --corpus to choose one", {
        available: names,
        workspace: workspace.root,
      });
    }
  }

  throw new CorpusNotFoundError("no corpus found; run 'graphdog init' first", {
    searched: workspaces.map((workspace) => workspace.root),
  });
}

function describe(workspace: Workspace, name: string): ResolvedCorpus {
  return {
    workspace,
    name,
    configPath: corpusConfigPath(workspace, name),
    storePath: corpusStorePath(workspace, name),
  };
}

export async function readCorpusConfig(resolved: ResolvedCorpus): Promise<CorpusConfig> {
  return loadCorpusConfig(resolved.configPath);
}

export async function writeCorpusConfig(
  resolved: ResolvedCorpus,
  config: CorpusConfig,
): Promise<void> {
  await saveCorpusConfig(resolved.configPath, config);
}

/**
 * Resolve a source URI written in a config.
 *
 * Relative paths are resolved against the *workspace's project directory*, not
 * the process working directory, so `graphdog search` gives the same answer
 * from any subdirectory of the repository.
 */
export function resolveSourceUri(workspace: Workspace, uri: string): string {
  if (isAbsolute(uri)) return uri;
  return resolve(dirname(workspace.root), uri);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
