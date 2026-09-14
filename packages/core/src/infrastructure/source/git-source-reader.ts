/**
 * A git working tree as a source.
 *
 * Git-awareness buys two things a plain folder walk cannot:
 *
 * - a **source revision** recorded with every document, so a citation can be
 *   pinned to a commit and `status` can tell you the corpus is behind HEAD;
 * - **`.gitignore` fidelity**, because `git ls-files` is the repository's own
 *   answer to "what is content here" and always beats re-implementing ignore
 *   rules, including nested and global ignore files.
 *
 * If git is unavailable the reader degrades to a filesystem walk and *says so*
 * through an exclusion record, rather than quietly indexing ignored files and
 * reporting no revision as though that were normal.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { NotFoundError } from "../../domain/errors.ts";
import { makeRef } from "../../domain/model/document.ts";
import type {
  DiscoveredFile,
  SourceExclusion,
  SourceReader,
  SourceSpec,
} from "../../application/ports/sources.ts";
import { ExclusionReason, isSecretPath, matchesAny } from "./exclusion-policy.ts";
import { LocalSourceReader } from "./local-source-reader.ts";
import { compareStrings } from "../../domain/ordering.ts";

const GIT_TIMEOUT_MS = 60_000;
/** Generous, but bounded: a huge repository should fail loudly, not hang. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export class GitSourceReader implements SourceReader {
  readonly spec: SourceSpec;
  readonly root: string;
  #supportedExtensions: ReadonlySet<string>;
  #exclusions: SourceExclusion[] = [];
  #fallback: LocalSourceReader | null = null;

  constructor(spec: SourceSpec, supportedExtensions: ReadonlySet<string>) {
    this.spec = spec;
    this.root = resolve(spec.uri);
    this.#supportedExtensions = supportedExtensions;
  }

  #git(args: readonly string[]): string | null {
    const result = spawnSync("git", ["-C", this.root, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    if (result.error !== undefined || result.status !== 0) return null;
    return result.stdout;
  }

  revision(): string | null {
    return this.#git(["rev-parse", "HEAD"])?.trim() ?? null;
  }

  /** True when the working tree has uncommitted changes. */
  isDirty(): boolean {
    const status = this.#git(["status", "--porcelain"]);
    return status !== null && status.trim() !== "";
  }

  exclusions(): SourceExclusion[] {
    return [...this.#exclusions, ...(this.#fallback?.exclusions() ?? [])];
  }

  discover(): DiscoveredFile[] {
    try {
      if (!statSync(this.root).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new NotFoundError(`source path does not exist: ${this.root}`, {
        source_id: this.spec.id,
        uri: this.root,
      });
    }

    this.#exclusions = [];
    this.#fallback = null;

    // `--cached --others --exclude-standard` lists tracked files plus untracked
    // ones that .gitignore does not exclude: new documents are indexable before
    // they are committed, which is what someone mid-edit actually wants.
    const listing = this.#git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (listing === null) {
      this.#exclusions.push({
        ref: this.spec.id,
        reason: ExclusionReason.GIT_UNAVAILABLE,
        details: {
          detail:
            "git ls-files failed, so this source fell back to a filesystem walk: " +
            ".gitignore rules were not applied and no revision is recorded",
        },
      });
      this.#fallback = new LocalSourceReader(this.spec, this.#supportedExtensions);
      return this.#fallback.discover();
    }

    const found: DiscoveredFile[] = [];
    const seen = new Set<string>();
    for (const entry of listing.split("\0")) {
      if (entry === "" || seen.has(entry)) continue;
      seen.add(entry);
      this.#considerFile(entry, found);
    }
    found.sort((a, b) => compareStrings(a.ref, b.ref));
    return found;
  }

  #considerFile(relativePath: string, found: DiscoveredFile[]): void {
    const ref = makeRef(this.spec.id, relativePath);
    const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);

    if (matchesAny(relativePath, this.spec.exclude)) return;

    if (!this.spec.indexSecrets && isSecretPath(relativePath)) {
      this.#exclusions.push({
        ref,
        reason: ExclusionReason.SECRET_PATTERN,
        details: { path: relativePath },
      });
      return;
    }

    if (this.spec.include.length > 0) {
      if (!matchesAny(relativePath, this.spec.include)) return;
    } else if (!this.#supportedExtensions.has(extensionOf(basename))) {
      return;
    }

    const absolutePath = join(this.root, ...relativePath.split("/"));
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch (error) {
      // Tracked but missing on disk: a sparse checkout, or a file removed
      // without being staged. Recorded rather than ignored, because a
      // disappearing document changes what search can find.
      this.#exclusions.push({
        ref,
        reason: ExclusionReason.UNREADABLE,
        details: { error: String(error) },
      });
      return;
    }

    if (!stat.isFile()) return;
    if (stat.size === 0) {
      this.#exclusions.push({ ref, reason: ExclusionReason.EMPTY_FILE, details: {} });
      return;
    }
    if (stat.size > this.spec.maxFileBytes) {
      this.#exclusions.push({
        ref,
        reason: ExclusionReason.FILE_TOO_LARGE,
        details: { size: stat.size, limit: this.spec.maxFileBytes },
      });
      return;
    }

    found.push({ ref, absolutePath, size: stat.size, mtime: stat.mtimeMs });
  }

  resolve(ref: string): string | null {
    const prefix = `${this.spec.id}/`;
    if (!ref.startsWith(prefix)) return null;
    const relativePath = ref.slice(prefix.length);
    if (isAbsolute(relativePath)) return null;

    const candidate = resolve(this.root, relativePath);
    const within = relative(this.root, candidate);
    if (within.startsWith("..") || isAbsolute(within)) return null;

    try {
      return statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  }
}

function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot).toLowerCase();
}


