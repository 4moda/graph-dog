/**
 * The record of what an install wrote, so an uninstall removes exactly that.
 *
 * Graphify's uninstall knows the shape of what it writes and removes it by
 * name. That works until a later version writes something different, and then
 * the older thing is stranded on the machine with nothing that knows about it.
 * So GraphDog writes a ledger instead: every file created, block inserted and
 * configuration key set, with the version that did it.
 *
 * The ledger is a convenience, never the only way back. Every artifact is also
 * identifiable from itself -- a fixed filename, a marker, a known key -- so a
 * project-scope integration can be removed from a clone this machine's ledger
 * has never seen, which is a teammate's checkout of a repository somebody else
 * ran `install --project` in.
 *
 * Everything here is pure. Reading and writing the file is infrastructure's.
 */

import { compareStrings } from "../ordering.ts";

/**
 * Whose configuration was written.
 *
 * Not the same axis as a corpus workspace's `project | home`: this is the
 * agent's own configuration -- `user` -- against files in the repository that
 * are meant to be committed -- `project`.
 */
export type IntegrationScope = "project" | "user";

/** One thing an install wrote, described by how to undo it. */
export interface InstalledArtifact {
  /**
   * - `file` -- GraphDog created it and owns the whole of it; uninstall deletes it.
   * - `block` -- a marker-delimited region in somebody else's file; uninstall
   *   removes the region and leaves the file.
   * - `key` -- a property in a JSON configuration; uninstall deletes the
   *   property and leaves the rest of the document.
   */
  readonly kind: "file" | "block" | "key";
  readonly path: string;
  /** The marker name for `block`, the dotted property path for `key`, null for `file`. */
  readonly at: string | null;
}

export interface InstallationRecord {
  readonly platform: string;
  readonly scope: IntegrationScope;
  /** The project root, for a project-scope install. Null for user scope. */
  readonly root: string | null;
  /** The GraphDog version that wrote it, so `doctor` can say "written by an older one". */
  readonly version: string;
  readonly installedAt: string;
  readonly artifacts: readonly InstalledArtifact[];
}

export interface Ledger {
  readonly version: 1;
  readonly installations: readonly InstallationRecord[];
}

export const EMPTY_LEDGER: Ledger = { version: 1, installations: [] };

/** Which installation a record is: one per platform, per scope, per project. */
function identity(record: { platform: string; scope: IntegrationScope; root: string | null }): string {
  return JSON.stringify([record.platform, record.scope, record.root ?? ""]);
}

export interface InstallationQuery {
  readonly platform?: string;
  readonly scope?: IntegrationScope;
  readonly root?: string | null;
}

function matches(record: InstallationRecord, query: InstallationQuery): boolean {
  if (query.platform !== undefined && record.platform !== query.platform) return false;
  if (query.scope !== undefined && record.scope !== query.scope) return false;
  if (query.root !== undefined && record.root !== query.root) return false;
  return true;
}

export function findInstallations(ledger: Ledger, query: InstallationQuery = {}): InstallationRecord[] {
  return ledger.installations.filter((record) => matches(record, query));
}

/**
 * Replace the record for this platform, scope and project, or add it.
 *
 * Replacing rather than appending is what makes re-running `install` safe: the
 * second run's artifacts are what is on the machine, and the first run's list
 * would only describe things that have since been overwritten.
 */
export function upsertInstallation(ledger: Ledger, record: InstallationRecord): Ledger {
  const key = identity(record);
  const kept = ledger.installations.filter((existing) => identity(existing) !== key);
  return { version: 1, installations: sort([...kept, record]) };
}

/** Drop every installation the query matches, and say which those were. */
export function removeInstallations(
  ledger: Ledger,
  query: InstallationQuery,
): { ledger: Ledger; removed: InstallationRecord[] } {
  const removed = findInstallations(ledger, query);
  const keys = new Set(removed.map(identity));
  return {
    ledger: { version: 1, installations: ledger.installations.filter((r) => !keys.has(identity(r))) },
    removed,
  };
}

function sort(records: readonly InstallationRecord[]): InstallationRecord[] {
  return [...records].sort(
    (a, b) =>
      compareStrings(a.platform, b.platform) ||
      compareStrings(a.scope, b.scope) ||
      compareStrings(a.root ?? "", b.root ?? ""),
  );
}

/**
 * Read a ledger out of whatever was in the file.
 *
 * Deliberately forgiving: this file is not a corpus, and a damaged one must not
 * stop somebody uninstalling. Anything unreadable is treated as "nothing is
 * recorded", which falls back to removing artifacts by their own identity --
 * the path that has to work anyway, for a checkout this machine never saw.
 */
export function parseLedger(value: unknown): Ledger {
  if (typeof value !== "object" || value === null) return EMPTY_LEDGER;
  const raw = (value as { installations?: unknown }).installations;
  if (!Array.isArray(raw)) return EMPTY_LEDGER;

  const installations: InstallationRecord[] = [];
  for (const entry of raw) {
    const record = parseRecord(entry);
    if (record !== null) installations.push(record);
  }
  return { version: 1, installations: sort(installations) };
}

function parseRecord(value: unknown): InstallationRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const platform = typeof row["platform"] === "string" ? row["platform"] : null;
  const scope = row["scope"] === "project" || row["scope"] === "user" ? row["scope"] : null;
  if (platform === null || platform === "" || scope === null) return null;

  const artifacts: InstalledArtifact[] = [];
  if (Array.isArray(row["artifacts"])) {
    for (const entry of row["artifacts"]) {
      const artifact = parseArtifact(entry);
      if (artifact !== null) artifacts.push(artifact);
    }
  }
  return {
    platform,
    scope,
    root: typeof row["root"] === "string" && row["root"] !== "" ? row["root"] : null,
    version: typeof row["version"] === "string" ? row["version"] : "unknown",
    installedAt: typeof row["installedAt"] === "string" ? row["installedAt"] : "",
    artifacts,
  };
}

function parseArtifact(value: unknown): InstalledArtifact | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const kind = row["kind"];
  const path = row["path"];
  if (kind !== "file" && kind !== "block" && kind !== "key") return null;
  if (typeof path !== "string" || path === "") return null;
  return { kind, path, at: typeof row["at"] === "string" ? row["at"] : null };
}
