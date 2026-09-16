/**
 * Wiring for `graphdog install` and `graphdog uninstall`.
 *
 * Connecting an agent means writing in two places that are not GraphDog's: the
 * agent's MCP configuration, and the file it reads instructions from. Both are
 * shared with the user and with other tools, so the rule throughout is that
 * GraphDog writes a named region and can point at exactly what it wrote.
 *
 * Which is what the ledger is for. Every write is recorded, and uninstall
 * removes what the record names -- plus, for the platform asked about, whatever
 * is at the known locations even if no record mentions it. That second path is
 * not belt and braces: a project-scope install is meant to be committed, so a
 * teammate's clone carries GraphDog's files on a machine whose ledger has never
 * heard of them.
 */

import { homedir } from "node:os";
import { chmod, readdir, readFile, rm, rmdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { VERSION } from "../version.ts";
import { ConfigError } from "../domain/errors.ts";
import {
  findInstallations,
  removeInstallations,
  upsertInstallation,
  type InstalledArtifact,
  type IntegrationScope,
} from "../domain/model/installation.ts";
import { hashMarkers, htmlMarkers, removeBlock, upsertBlock } from "../domain/service/marker-block.ts";
import type { Logger } from "../application/ports/system.ts";
import { SILENT_LOGGER } from "../application/ports/system.ts";
import {
  AGENT_PLATFORMS,
  INTEGRATION_NAME,
  UPDATE_COMMAND,
  findPlatform,
  instructionBody,
  mcpServerEntry,
  targetsFor,
  type AgentPlatform,
  type PlatformTargets,
} from "../infrastructure/integration/agent-platforms.ts";
import {
  deleteAtPath,
  getAtPath,
  isEmptyConfig,
  readJsonConfig,
  setAtPath,
  writeJsonConfig,
  type JsonObject,
} from "../infrastructure/integration/json-config-file.ts";
import { readLedger, writeLedger } from "../infrastructure/integration/installation-ledger.ts";
import { findProjectWorkspace } from "../infrastructure/config/workspace.ts";

const MARKERS = htmlMarkers(INTEGRATION_NAME);
const SCRIPT_MARKERS = hashMarkers(INTEGRATION_NAME);

/** What happened to one file, key or block. */
export interface IntegrationChange {
  readonly action: "created" | "updated" | "removed" | "unchanged" | "absent";
  readonly kind: InstalledArtifact["kind"];
  readonly path: string;
  readonly at: string | null;
}

export interface IntegrationOutcome {
  readonly operation: "install" | "uninstall";
  readonly platforms: readonly string[];
  /** Null for an uninstall that was not restricted to one scope. */
  readonly scope: IntegrationScope | null;
  readonly root: string | null;
  readonly dryRun: boolean;
  readonly changes: readonly IntegrationChange[];
}

export interface InstallIntegrationOptions {
  /** Omitted only when `gitHooks` is asked for on its own. */
  readonly platform?: string;
  /** Also write git hooks. Opt-in: the agent's own lifecycle already covers this. */
  readonly gitHooks?: boolean;
  /** Default `user`: the agent's own configuration. `project` writes committable files. */
  readonly scope?: IntegrationScope;
  /** Expose the MCP server's write tools. Off unless asked, as it is for the server itself. */
  readonly allowWrite?: boolean;
  readonly dryRun?: boolean;
  readonly cwd?: string;
  readonly logger?: Logger;
}

export interface UninstallIntegrationOptions {
  /** One platform, or every platform the ledger knows when omitted. */
  readonly platform?: string;
  readonly scope?: IntegrationScope;
  readonly dryRun?: boolean;
  readonly cwd?: string;
  readonly logger?: Logger;
}

/**
 * The directory a scope's relative paths hang off.
 *
 * For a project, the directory holding `.graphdog` if there is one above the
 * working directory -- so running this from a subdirectory writes at the top of
 * the repository, where the agent will look -- and the working directory
 * otherwise.
 */
async function baseFor(scope: IntegrationScope, cwd: string): Promise<string> {
  if (scope === "user") return homedir();
  const workspace = await findProjectWorkspace(cwd);
  return workspace === null ? resolve(cwd) : dirname(workspace.root);
}

function artifactsFor(targets: PlatformTargets, base: string): InstalledArtifact[] {
  const artifacts: InstalledArtifact[] = [
    { kind: "key", path: join(base, targets.mcp.file), at: `${targets.mcp.container}.${INTEGRATION_NAME}` },
    targets.instructions.own
      ? { kind: "file" as const, path: join(base, targets.instructions.file), at: null }
      : { kind: "block" as const, path: join(base, targets.instructions.file), at: INTEGRATION_NAME },
  ];
  if (targets.hooks !== null) {
    for (const event of targets.hooks.events) {
      artifacts.push({
        kind: "hook",
        path: join(base, targets.hooks.file),
        at: `${targets.hooks.container}.${event}`,
      });
    }
  }
  return artifacts;
}

// --- install -----------------------------------------------------------------

export async function installAgentIntegration(
  options: InstallIntegrationOptions,
): Promise<IntegrationOutcome> {
  const logger = options.logger ?? SILENT_LOGGER;
  const scope = options.scope ?? "user";
  const dryRun = options.dryRun === true;
  const cwd = options.cwd ?? process.cwd();
  const wantsGitHooks = options.gitHooks === true;

  if (options.platform === undefined && !wantsGitHooks) {
    throw new ConfigError("nothing to install: name an agent with --platform, or ask for --git-hooks");
  }

  const changes: IntegrationChange[] = [];
  const done: string[] = [];
  let ledger = await readLedger();
  const stamp = new Date().toISOString();
  let root: string | null = null;

  if (options.platform !== undefined) {
    const platform = findPlatform(options.platform);
    const targets = targetsFor(platform, scope);
    const base = await baseFor(scope, cwd);
    root = scope === "project" ? base : null;

    changes.push(
      await writeMcpRegistration(join(base, targets.mcp.file), targets, options.allowWrite === true, dryRun),
      targets.instructions.own
        ? await writeOwnInstructions(join(base, targets.instructions.file), platform, dryRun)
        : await writeInstructionBlock(join(base, targets.instructions.file), dryRun),
    );
    if (targets.hooks !== null) {
      changes.push(...(await writeAgentHooks(join(base, targets.hooks.file), targets, dryRun)));
    }

    done.push(platform.id);
    ledger = upsertInstallation(ledger, {
      platform: platform.id,
      scope,
      root,
      version: VERSION,
      installedAt: stamp,
      artifacts: artifactsFor(targets, base),
    });
  }

  if (wantsGitHooks) {
    // Always the project: a git hook belongs to a working tree, never to a user.
    const base = await baseFor("project", cwd);
    changes.push(...(await writeGitHooks(base, dryRun)));
    done.push(GIT_HOOKS);
    const gitDir = await gitDirectory(base);
    if (gitDir !== null) {
      ledger = upsertInstallation(ledger, {
        platform: GIT_HOOKS,
        scope: "project",
        root: base,
        version: VERSION,
        installedAt: stamp,
        artifacts: gitArtifacts(gitDir),
      });
    }
  }

  if (!dryRun) await writeLedger(ledger);

  logger.log("info", "installed integration", { platforms: done, scope, dry_run: dryRun });
  return { operation: "install", platforms: done, scope, root, dryRun, changes };
}

async function writeMcpRegistration(
  path: string,
  targets: PlatformTargets,
  allowWrite: boolean,
  dryRun: boolean,
): Promise<IntegrationChange> {
  const at = `${targets.mcp.container}.${INTEGRATION_NAME}`;
  const existing = await readJsonConfig(path);
  const document: JsonObject = existing ?? {};
  const updated = setAtPath(document, at, mcpServerEntry({ allowWrite }));
  const action = existing === null ? "created" : same(document, updated) ? "unchanged" : "updated";

  if (!dryRun && action !== "unchanged") await writeJsonConfig(path, updated);
  return { action, kind: "key", path, at };
}

async function writeOwnInstructions(
  path: string,
  platform: AgentPlatform,
  dryRun: boolean,
): Promise<IntegrationChange> {
  const body = `${instructionBody()}\n\n<!-- written by graphdog ${VERSION} for ${platform.title} -->\n`;
  const existing = await readTextOrNull(path);
  const action = existing === null ? "created" : existing === body ? "unchanged" : "updated";

  if (!dryRun && action !== "unchanged") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, "utf8");
  }
  return { action, kind: "file", path, at: null };
}

async function writeInstructionBlock(path: string, dryRun: boolean): Promise<IntegrationChange> {
  const existing = await readTextOrNull(path);
  const body = `${instructionBody()}\n\n_Written by graphdog ${VERSION}. Edits inside this block are overwritten._`;
  const updated = upsertBlock(existing ?? "", MARKERS, body);
  const action = existing === null ? "created" : existing === updated ? "unchanged" : "updated";

  if (!dryRun && action !== "unchanged") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, updated, "utf8");
  }
  return { action, kind: "block", path, at: INTEGRATION_NAME };
}

/**
 * One hook entry per event, appended beside whatever is already there.
 *
 * An event's hooks are a *list*, so this appends rather than sets, and the
 * uninstall below removes one element rather than the key -- deleting the key
 * would take every other tool's hook for that event with it.
 */
async function writeAgentHooks(
  path: string,
  targets: PlatformTargets,
  dryRun: boolean,
): Promise<IntegrationChange[]> {
  const hooks = targets.hooks;
  if (hooks === null) return [];

  const existing = await readJsonConfig(path);
  let document: JsonObject = existing ?? {};
  const changes: IntegrationChange[] = [];

  for (const event of hooks.events) {
    const at = `${hooks.container}.${event}`;
    const current = asArray(getAtPath(document, at));
    if (current.some(isOurHook)) {
      changes.push({ action: "unchanged", kind: "hook", path, at });
      continue;
    }
    document = setAtPath(document, at, [...current, ourHookEntry()]);
    changes.push({ action: existing === null ? "created" : "updated", kind: "hook", path, at });
  }

  const wrote = changes.some((change) => change.action !== "unchanged");
  if (!dryRun && wrote) await writeJsonConfig(path, document);
  return changes;
}

function ourHookEntry(): JsonObject {
  return { hooks: [{ type: "command", command: UPDATE_COMMAND }] };
}

/**
 * Is this entry one of ours?
 *
 * Matched on the command GraphDog writes. Somebody who wrote that exact line
 * themselves loses it to an uninstall, which is the right trade: the
 * alternative is an extra marker property in a schema that is not ours.
 */
function isOurHook(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const inner = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(inner)) return false;
  return inner.some(
    (hook) =>
      typeof hook === "object" &&
      hook !== null &&
      (hook as { command?: unknown }).command === UPDATE_COMMAND,
  );
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- git hooks ---------------------------------------------------------------

/**
 * The ledger name git hooks are filed under.
 *
 * Not an agent, and deliberately not offered by `--platform`: git hooks are
 * opt-in, because the agent's own lifecycle already says when the index needs
 * refreshing and `.git/hooks` is poor ground to depend on -- see
 * [distribution](../../../docs/design/distribution.md).
 */
export const GIT_HOOKS = "git";

/** Fired by a commit, a pull, a branch switch and a rebase, in that order of likelihood. */
const GIT_HOOK_NAMES = ["post-commit", "post-merge", "post-checkout", "post-rewrite"] as const;

/** A repository whose hooks another tool owns. GraphDog will not fight it for them. */
const HOOK_MANAGERS: ReadonlyArray<{ readonly name: string; readonly marker: string }> = [
  { name: "husky", marker: ".husky" },
  { name: "lefthook", marker: "lefthook.yml" },
  { name: "lefthook", marker: "lefthook.yaml" },
  { name: "pre-commit", marker: ".pre-commit-config.yaml" },
];

/**
 * The real `.git` directory, following the `gitdir:` pointer a worktree uses.
 */
async function gitDirectory(root: string): Promise<string | null> {
  const dot = join(root, ".git");
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dot);
  } catch {
    return null;
  }
  if (info.isDirectory()) return dot;

  const pointer = (await readTextOrNull(dot)) ?? "";
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (match?.[1] === undefined) return null;
  const target = match[1].trim();
  return target.startsWith("/") ? target : join(root, target);
}

async function detectHookManager(root: string): Promise<string | null> {
  for (const manager of HOOK_MANAGERS) {
    try {
      await stat(join(root, manager.marker));
      return manager.name;
    } catch {
      // not this one
    }
  }
  return null;
}

async function writeGitHooks(root: string, dryRun: boolean): Promise<IntegrationChange[]> {
  const gitDir = await gitDirectory(root);
  if (gitDir === null) {
    throw new ConfigError(`${root} is not a git working tree, so there are no git hooks to install`, {
      remedy: "install the agent's own hooks instead, with --platform",
    });
  }

  // husky, lefthook and pre-commit own `.git/hooks` and regenerate it, so
  // GraphDog's lines would vanish at the next install -- silently, which is the
  // worst way for a refresh to stop happening.
  const manager = await detectHookManager(root);
  if (manager !== null) {
    throw new ConfigError(`this repository's git hooks are managed by ${manager}`, {
      manager,
      remedy: `add this line to your ${manager} configuration instead: ${UPDATE_COMMAND}`,
    });
  }

  const changes: IntegrationChange[] = [];
  for (const name of GIT_HOOK_NAMES) {
    const path = join(gitDir, "hooks", name);
    const existing = await readTextOrNull(path);
    const updated = upsertBlock(existing ?? "#!/bin/sh\n", SCRIPT_MARKERS, UPDATE_COMMAND);
    const action = existing === null ? "created" : existing === updated ? "unchanged" : "updated";
    if (!dryRun && action !== "unchanged") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, updated, { encoding: "utf8", mode: 0o755 });
      // An existing hook keeps whatever mode it had unless it cannot run.
      await chmod(path, 0o755);
    }
    changes.push({ action, kind: "block", path, at: INTEGRATION_NAME });
  }
  return changes;
}

function gitArtifacts(gitDir: string): InstalledArtifact[] {
  return GIT_HOOK_NAMES.map((name) => ({
    kind: "block" as const,
    path: join(gitDir, "hooks", name),
    at: INTEGRATION_NAME,
  }));
}

// --- uninstall ---------------------------------------------------------------

export async function uninstallAgentIntegration(
  options: UninstallIntegrationOptions,
): Promise<IntegrationOutcome> {
  const logger = options.logger ?? SILENT_LOGGER;
  const dryRun = options.dryRun === true;
  const cwd = options.cwd ?? process.cwd();
  const everything = options.platform === undefined;
  const wantsGit = everything || options.platform === GIT_HOOKS;
  const platforms = everything
    ? AGENT_PLATFORMS
    : options.platform === GIT_HOOKS
      ? []
      : [findPlatform(options.platform ?? "")];

  const ledger = await readLedger();
  const query = {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  };

  // Everything the ledger recorded, plus the known locations for the platforms
  // asked about -- a project-scope install is committed, so a clone can carry
  // GraphDog's files on a machine whose ledger has never seen them.
  const wanted: InstalledArtifact[] = findInstallations(ledger, query).flatMap((record) => record.artifacts);
  const scopes: IntegrationScope[] = options.scope === undefined ? ["project", "user"] : [options.scope];
  for (const platform of platforms) {
    for (const scope of scopes) {
      const targets = scope === "project" ? platform.project : platform.user;
      if (targets === null) continue;
      wanted.push(...artifactsFor(targets, await baseFor(scope, cwd)));
    }
  }
  if (wantsGit && scopes.includes("project")) {
    const gitDir = await gitDirectory(await baseFor("project", cwd));
    if (gitDir !== null) wanted.push(...gitArtifacts(gitDir));
  }

  const changes: IntegrationChange[] = [];
  for (const artifact of dedupe(wanted)) changes.push(await removeArtifact(artifact, dryRun));

  if (!dryRun) {
    const { ledger: after } = removeInstallations(ledger, query);
    await writeLedger(after);
  }

  logger.log("info", "uninstalled integration", {
    platforms: platforms.map((platform) => platform.id),
    dry_run: dryRun,
  });
  return {
    operation: "uninstall",
    platforms: [...platforms.map((platform) => platform.id), ...(wantsGit ? [GIT_HOOKS] : [])],
    scope: options.scope ?? null,
    root: null,
    dryRun,
    changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

async function removeArtifact(artifact: InstalledArtifact, dryRun: boolean): Promise<IntegrationChange> {
  const absent: IntegrationChange = { action: "absent", kind: artifact.kind, path: artifact.path, at: artifact.at };

  if (artifact.kind === "file") {
    if ((await readTextOrNull(artifact.path)) === null) return absent;
    if (!dryRun) {
      await rm(artifact.path, { force: true });
      await pruneEmptyParents(artifact.path);
    }
    return { ...absent, action: "removed" };
  }

  if (artifact.kind === "block") {
    const text = await readTextOrNull(artifact.path);
    if (text === null) return absent;
    // A Markdown file carries HTML markers and a hook script `#` ones; the two
    // are distinct strings, so trying both is unambiguous.
    const stripped = removeBlock(text, MARKERS) ?? removeBlock(text, SCRIPT_MARKERS);
    if (stripped === null) return absent;
    if (!dryRun) {
      // A file with nothing left in it was ours alone; one with anything left
      // is somebody else's and keeps everything outside our markers.
      if (stripped === "" || stripped.trim() === "#!/bin/sh") {
        await rm(artifact.path, { force: true });
        await pruneEmptyParents(artifact.path);
      } else {
        await writeFile(artifact.path, stripped, "utf8");
      }
    }
    return { ...absent, action: "removed" };
  }

  const document = await readJsonConfig(artifact.path);
  if (document === null || artifact.at === null) return absent;

  if (artifact.kind === "hook") {
    const current = asArray(getAtPath(document, artifact.at));
    const kept = current.filter((entry) => !isOurHook(entry));
    if (kept.length === current.length) return absent;
    // An event nobody else hooks loses the key; one somebody else hooks keeps
    // theirs. Either way the pruning below can still empty the file.
    const next =
      kept.length === 0 ? deleteAtPath(document, artifact.at).document : setAtPath(document, artifact.at, kept);
    if (!dryRun) {
      if (isEmptyConfig(next)) {
        await rm(artifact.path, { force: true });
        await pruneEmptyParents(artifact.path);
      } else {
        await writeJsonConfig(artifact.path, next);
      }
    }
    return { ...absent, action: "removed" };
  }

  const { document: stripped, removed } = deleteAtPath(document, artifact.at);
  if (!removed) return absent;
  if (!dryRun) {
    if (isEmptyConfig(stripped)) {
      await rm(artifact.path, { force: true });
      await pruneEmptyParents(artifact.path);
    } else {
      await writeJsonConfig(artifact.path, stripped);
    }
  }
  return { ...absent, action: "removed" };
}

/**
 * Remove directories an install created and nothing else uses.
 *
 * `.github/instructions/` and `.vscode/` may not have existed before, and
 * leaving them behind empty is the kind of debris that makes people doubt an
 * uninstall. Only a directory that is *empty* goes, so one the user already had
 * something in is never touched, and the walk stops at the first that is not.
 */
async function pruneEmptyParents(path: string, levels = 3): Promise<void> {
  let directory = dirname(path);
  for (let depth = 0; depth < levels; depth += 1) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    try {
      await rmdir(directory);
    } catch {
      return;
    }
    directory = dirname(directory);
  }
}

// --- shared ------------------------------------------------------------------

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function same(left: JsonObject, right: JsonObject): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dedupe(artifacts: readonly InstalledArtifact[]): InstalledArtifact[] {
  const seen = new Set<string>();
  const out: InstalledArtifact[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.kind}:${artifact.path}:${artifact.at ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(artifact);
  }
  return out;
}

/** Every platform `install --platform` accepts, for help text and `doctor`. */
export function knownPlatforms(): Array<{ id: string; title: string; scopes: IntegrationScope[] }> {
  return AGENT_PLATFORMS.map((platform) => ({
    id: platform.id,
    title: platform.title,
    scopes: [
      ...(platform.project === null ? [] : (["project"] as IntegrationScope[])),
      ...(platform.user === null ? [] : (["user"] as IntegrationScope[])),
    ],
  }));
}
