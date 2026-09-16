/**
 * `graphdog doctor` -- one report of everything installed, and anything wrong.
 *
 * Graphify answers this per subsystem: `hook status` for the hooks, and nothing
 * for the rest. The question people actually have after an upgrade is "is any
 * of what I set up broken now", and answering it in one command is the point.
 *
 * Two rules shape what it does:
 *
 * - **It never loads a model.** A semantic corpus's compatibility is decided by
 *   comparing recorded identities, and instantiating the embedder to find that
 *   out could mean a download -- from a command whose whole job is to tell you
 *   whether things are in order.
 * - **Every problem carries the command that fixes it.** A report that says
 *   something is wrong and leaves the reader to work out what to do about it is
 *   half a report.
 */

import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { VERSION } from "../version.ts";
import { SCHEMA_VERSION } from "../domain/model/corpus-identity.ts";
import { findInstallations } from "../domain/model/installation.ts";
import type { IntegrationScope } from "../domain/model/installation.ts";
import { CORPUS_META_KEYS } from "../application/corpus-meta.ts";
import type { Logger } from "../application/ports/system.ts";
import { SILENT_LOGGER } from "../application/ports/system.ts";
import { readLedger } from "../infrastructure/integration/installation-ledger.ts";
import {
  corpusStorePath,
  homeWorkspace,
  listCorpusNames,
  visibleWorkspaces,
  type Workspace,
} from "../infrastructure/config/workspace.ts";
import { openDatabase } from "../infrastructure/persistence/sqlite/database.ts";

/** One line of the report, and whether it is a problem. */
export interface DoctorFinding {
  readonly section: "install" | "home" | "extras" | "agents" | "corpora";
  readonly label: string;
  readonly detail: string;
  readonly status: "ok" | "warn" | "broken";
  /** The command that fixes it, when there is one. */
  readonly remedy: string | null;
}

export interface DoctorReport {
  readonly version: string;
  readonly node: string;
  readonly findings: readonly DoctorFinding[];
  /** True when nothing is broken. A warning is not a failure. */
  readonly healthy: boolean;
}

export interface DoctorOptions {
  readonly cwd?: string;
  readonly logger?: Logger;
}

/** Optional capabilities, and the package each needs. */
const EXTRAS: ReadonlyArray<{ readonly name: string; readonly module: string }> = [
  { name: "semantic embeddings", module: "@huggingface/transformers" },
  { name: "PDF extraction", module: "pdfjs-dist" },
  { name: "DOCX extraction", module: "mammoth" },
];

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const logger = options.logger ?? SILENT_LOGGER;
  const cwd = options.cwd ?? process.cwd();

  const findings: DoctorFinding[] = [
    ...(await inspectHome()),
    ...inspectExtras(),
    ...(await inspectAgents()),
    ...(await inspectCorpora(cwd)),
  ];

  const healthy = !findings.some((finding) => finding.status === "broken");
  logger.log("info", "doctor", { findings: findings.length, healthy });
  return { version: VERSION, node: process.version, findings, healthy };
}

// --- home --------------------------------------------------------------------

async function inspectHome(): Promise<DoctorFinding[]> {
  const home = homeWorkspace();
  const names = await listCorpusNames(home).catch(() => []);
  const bytes = await directorySize(home.root);
  return [
    {
      section: "home",
      label: home.root,
      detail: `${names.length} corpus/corpora, ${formatBytes(bytes)}`,
      status: "ok",
      remedy: null,
    },
  ];
}

// --- extras ------------------------------------------------------------------

function inspectExtras(): DoctorFinding[] {
  const resolve = createRequire(import.meta.url).resolve;

  /**
   * Is the package here?
   *
   * The bare specifier, not `<name>/package.json`: a package whose `exports`
   * does not list `./package.json` -- `@huggingface/transformers` is one --
   * fails that lookup with `ERR_PACKAGE_PATH_NOT_EXPORTED` while being
   * perfectly well installed. Only "cannot find the module" means absent;
   * every other refusal is the package declining to show that particular file.
   */
  const installed = (module: string): boolean => {
    try {
      resolve(module);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND";
    }
  };

  return EXTRAS.map((extra) => {
    if (installed(extra.module)) {
      return {
        section: "extras" as const,
        label: extra.name,
        detail: `${extra.module} available`,
        status: "ok" as const,
        remedy: null,
      };
    }
    // Not installed is the documented default, not a fault: GraphDog works
    // offline with none of them, and each says so when it is needed.
    return {
      section: "extras" as const,
      label: extra.name,
      detail: "not installed",
      status: "ok" as const,
      remedy: `npm install -g ${extra.module}`,
    };
  });
}

// --- agents ------------------------------------------------------------------

async function inspectAgents(): Promise<DoctorFinding[]> {
  const ledger = await readLedger();
  const installations = findInstallations(ledger);
  if (installations.length === 0) {
    return [
      {
        section: "agents",
        label: "none",
        detail: "no agent integration is installed",
        status: "ok",
        remedy: "graphdog install --platform claude",
      },
    ];
  }

  const findings: DoctorFinding[] = [];
  for (const record of installations) {
    const missing: string[] = [];
    for (const artifact of record.artifacts) {
      if (!(await exists(artifact.path))) missing.push(artifact.path);
    }

    const where = `${record.scope}${record.root === null ? "" : ` ${record.root}`}`;
    if (missing.length > 0) {
      findings.push({
        section: "agents",
        label: `${record.platform} (${where})`,
        // Something removed these behind GraphDog's back -- an editor, a
        // `git clean`, a teammate's commit. The registration is half there,
        // which is worse than not there: the agent may still start the server.
        detail: `${missing.length} of ${record.artifacts.length} written file(s) missing: ${missing.join(", ")}`,
        status: "broken",
        remedy: reinstallCommand(record.platform, record.scope),
      });
      continue;
    }

    const stale = record.version !== VERSION;
    findings.push({
      section: "agents",
      label: `${record.platform} (${where})`,
      detail: stale ? `written by ${record.version}, this is ${VERSION}` : `ok (${record.version})`,
      status: stale ? "warn" : "ok",
      remedy: stale ? reinstallCommand(record.platform, record.scope) : null,
    });
  }
  return findings;
}

function reinstallCommand(platform: string, scope: IntegrationScope): string {
  const project = scope === "project" ? " --project" : "";
  return platform === "git"
    ? `graphdog install --git-hooks${project}`
    : `graphdog install --platform ${platform}${project}`;
}

// --- corpora -----------------------------------------------------------------

async function inspectCorpora(cwd: string): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  for (const workspace of await visibleWorkspaces(cwd)) {
    for (const name of await listCorpusNames(workspace).catch(() => [])) {
      findings.push(await inspectCorpus(workspace, name));
    }
  }
  if (findings.length === 0) {
    findings.push({
      section: "corpora",
      label: "none",
      detail: "no corpus is visible from here",
      status: "ok",
      remedy: "graphdog init",
    });
  }
  return findings;
}

async function inspectCorpus(workspace: Workspace, name: string): Promise<DoctorFinding> {
  const label = `${name} (${workspace.scope})`;
  const path = corpusStorePath(workspace, name);
  if (!(await exists(path))) {
    return {
      section: "corpora",
      label,
      detail: "configured but never built",
      status: "warn",
      remedy: `graphdog build --corpus ${name}`,
    };
  }

  // Read the recorded identity straight out of the file. Opening the corpus
  // properly would construct its embedding model, which for a semantic corpus
  // can mean a download.
  let meta: Map<string, string>;
  try {
    meta = await readMeta(path);
  } catch (error) {
    return {
      section: "corpora",
      label,
      detail: `unreadable: ${String(error)}`,
      status: "broken",
      remedy: `graphdog build --full --corpus ${name}`,
    };
  }

  const schema = meta.get(CORPUS_META_KEYS.schemaVersion) ?? SCHEMA_VERSION;
  if (schema !== SCHEMA_VERSION) {
    return {
      section: "corpora",
      label,
      detail: `built against schema ${schema}; this version reads ${SCHEMA_VERSION}`,
      status: "broken",
      remedy: `graphdog build --full --corpus ${name}`,
    };
  }

  const builtAt = meta.get(CORPUS_META_KEYS.builtAt);
  if (builtAt === null || builtAt === undefined) {
    return {
      section: "corpora",
      label,
      detail: "has a database but no build recorded in it",
      status: "warn",
      remedy: `graphdog build --corpus ${name}`,
    };
  }

  const embedding = meta.get(CORPUS_META_KEYS.embeddingId) ?? "unknown";
  return {
    section: "corpora",
    label,
    detail: `built ${builtAt} with ${embedding}`,
    status: "ok",
    remedy: null,
  };
}

async function readMeta(path: string): Promise<Map<string, string>> {
  const database = await openDatabase(path, { readOnly: true });
  try {
    const rows = database.prepare("SELECT key, value FROM meta").all();
    return new Map(rows.map((row) => [String(row["key"]), String(row["value"])] as const));
  } finally {
    database.close();
  }
}

// --- shared ------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return 0;
  }
  for (const name of names) {
    const child = join(path, name);
    const info = await stat(child).catch(() => null);
    if (info === null) continue;
    if (info.isDirectory()) total += await directorySize(child);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
