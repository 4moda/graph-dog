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
import { readdir, readFile, rm, rmdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { VERSION } from "../version.ts";
import {
  findInstallations,
  removeInstallations,
  upsertInstallation,
  type InstallationRecord,
  type InstalledArtifact,
  type IntegrationScope,
} from "../domain/model/installation.ts";
import { htmlMarkers, removeBlock, upsertBlock } from "../domain/service/marker-block.ts";
import type { Logger } from "../application/ports/system.ts";
import { SILENT_LOGGER } from "../application/ports/system.ts";
import {
  AGENT_PLATFORMS,
  INTEGRATION_NAME,
  findPlatform,
  instructionBody,
  mcpServerEntry,
  targetsFor,
  type AgentPlatform,
  type PlatformTargets,
} from "../infrastructure/integration/agent-platforms.ts";
import {
  deleteAtPath,
  isEmptyConfig,
  readJsonConfig,
  setAtPath,
  writeJsonConfig,
  type JsonObject,
} from "../infrastructure/integration/json-config-file.ts";
import { readLedger, writeLedger } from "../infrastructure/integration/installation-ledger.ts";
import { findProjectWorkspace } from "../infrastructure/config/workspace.ts";

const MARKERS = htmlMarkers(INTEGRATION_NAME);

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
  readonly platform: string;
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
  return [
    { kind: "key", path: join(base, targets.mcp.file), at: `${targets.mcp.container}.${INTEGRATION_NAME}` },
    targets.instructions.own
      ? { kind: "file" as const, path: join(base, targets.instructions.file), at: null }
      : { kind: "block" as const, path: join(base, targets.instructions.file), at: INTEGRATION_NAME },
  ];
}

// --- install -----------------------------------------------------------------

export async function installAgentIntegration(
  options: InstallIntegrationOptions,
): Promise<IntegrationOutcome> {
  const logger = options.logger ?? SILENT_LOGGER;
  const scope = options.scope ?? "user";
  const dryRun = options.dryRun === true;
  const platform = findPlatform(options.platform);
  const targets = targetsFor(platform, scope);
  const base = await baseFor(scope, options.cwd ?? process.cwd());

  const changes: IntegrationChange[] = [
    await writeMcpRegistration(join(base, targets.mcp.file), targets, options.allowWrite === true, dryRun),
    targets.instructions.own
      ? await writeOwnInstructions(join(base, targets.instructions.file), platform, dryRun)
      : await writeInstructionBlock(join(base, targets.instructions.file), dryRun),
  ];

  if (!dryRun) {
    const record: InstallationRecord = {
      platform: platform.id,
      scope,
      root: scope === "project" ? base : null,
      version: VERSION,
      installedAt: new Date().toISOString(),
      artifacts: artifactsFor(targets, base),
    };
    await writeLedger(upsertInstallation(await readLedger(), record));
  }

  logger.log("info", "installed agent integration", {
    platform: platform.id,
    scope,
    dry_run: dryRun,
  });
  return {
    operation: "install",
    platforms: [platform.id],
    scope,
    root: scope === "project" ? base : null,
    dryRun,
    changes,
  };
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

// --- uninstall ---------------------------------------------------------------

export async function uninstallAgentIntegration(
  options: UninstallIntegrationOptions,
): Promise<IntegrationOutcome> {
  const logger = options.logger ?? SILENT_LOGGER;
  const dryRun = options.dryRun === true;
  const cwd = options.cwd ?? process.cwd();
  const platforms = options.platform === undefined ? AGENT_PLATFORMS : [findPlatform(options.platform)];

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

  const changes: IntegrationChange[] = [];
  for (const artifact of dedupe(wanted)) changes.push(await removeArtifact(artifact, dryRun));

  if (!dryRun) {
    const { ledger: after } = removeInstallations(ledger, query);
    await writeLedger(after);
  }

  logger.log("info", "uninstalled agent integration", {
    platforms: platforms.map((platform) => platform.id),
    dry_run: dryRun,
  });
  return {
    operation: "uninstall",
    platforms: platforms.map((platform) => platform.id),
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
    const stripped = removeBlock(text, MARKERS);
    if (stripped === null) return absent;
    if (!dryRun) {
      // A file with nothing left in it was ours alone; one with anything left
      // is somebody else's and keeps everything outside our markers.
      if (stripped === "") {
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
