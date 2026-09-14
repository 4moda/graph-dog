/**
 * A plain directory tree as a source.
 *
 * Walks the tree in sorted order so two builds of the same folder see files in
 * the same sequence -- which matters because chunk ordinals and therefore chunk
 * ids depend on it.
 */

import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { NotFoundError } from "../../domain/errors.ts";
import { makeRef } from "../../domain/model/document.ts";
import type {
  DiscoveredFile,
  SourceExclusion,
  SourceReader,
  SourceSpec,
} from "../../application/ports/sources.ts";
import {
  ExclusionReason,
  isSecretPath,
  isSkippedDirectory,
  matchesAny,
} from "./exclusion-policy.ts";
import { compareStrings } from "../../domain/ordering.ts";

export class LocalSourceReader implements SourceReader {
  readonly spec: SourceSpec;
  readonly root: string;
  #supportedExtensions: ReadonlySet<string>;
  #exclusions: SourceExclusion[] = [];

  constructor(spec: SourceSpec, supportedExtensions: ReadonlySet<string>) {
    this.spec = spec;
    this.root = resolve(spec.uri);
    this.#supportedExtensions = supportedExtensions;
  }

  revision(): string | null {
    // A plain folder has no revision. Returning null rather than a synthetic
    // one keeps `status` honest: it reports "unknown", not a false "current".
    return null;
  }

  exclusions(): SourceExclusion[] {
    return [...this.#exclusions];
  }

  discover(): DiscoveredFile[] {
    let rootStat;
    try {
      rootStat = statSync(this.root);
    } catch {
      throw new NotFoundError(`source path does not exist: ${this.root}`, {
        source_id: this.spec.id,
        uri: this.root,
      });
    }
    if (!rootStat.isDirectory()) {
      throw new NotFoundError(`source path is not a directory: ${this.root}`, {
        source_id: this.spec.id,
      });
    }

    this.#exclusions = [];
    const found: DiscoveredFile[] = [];
    this.#walk(this.root, found, new Set());
    found.sort((a, b) => compareStrings(a.ref, b.ref));
    return found;
  }

  #walk(directory: string, found: DiscoveredFile[], visited: Set<string>): void {
    // Guard against symlink loops when following symlinks is enabled.
    const key = resolve(directory);
    if (visited.has(key)) return;
    visited.add(key);

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      this.#exclusions.push({
        ref: makeRef(this.spec.id, relative(this.root, directory)),
        reason: ExclusionReason.UNREADABLE,
        details: { error: String(error) },
      });
      return;
    }

    for (const entry of [...entries].sort((a, b) => compareStrings(a.name, b.name))) {
      const absolute = join(directory, entry.name);
      const isSymlink = entry.isSymbolicLink();
      if (isSymlink && !this.spec.followSymlinks) continue;

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (isSymlink) {
        try {
          const target = statSync(absolute);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // broken symlink
        }
      }

      if (isDirectory) {
        if (!isSkippedDirectory(entry.name)) this.#walk(absolute, found, visited);
        continue;
      }
      if (!isFile) continue;
      this.#considerFile(absolute, found);
    }
  }

  #considerFile(absolutePath: string, found: DiscoveredFile[]): void {
    const relativePath = relative(this.root, absolutePath).split(sep).join("/");
    const ref = makeRef(this.spec.id, relativePath);
    const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);

    if (matchesAny(relativePath, this.spec.exclude)) return;

    // Checked before the dotfile rule, because the most common secrets are
    // dotfiles: skipping `.env` as "just a dotfile" would drop it from the
    // audit trail, and "nothing was excluded" would be a false statement.
    if (!this.spec.indexSecrets && isSecretPath(relativePath)) {
      this.#exclusions.push({
        ref,
        reason: ExclusionReason.SECRET_PATTERN,
        details: { path: relativePath },
      });
      return;
    }

    if (basename.startsWith(".")) return;

    if (this.spec.include.length > 0) {
      if (!matchesAny(relativePath, this.spec.include)) return;
    } else if (!this.#supportedExtensions.has(extensionOf(basename))) {
      // Silently skipped rather than recorded: a repository is mostly files
      // GraphDog has no reader for, and listing them all would bury the
      // exclusions that actually matter.
      return;
    }

    let stat;
    try {
      stat = statSync(absolutePath);
    } catch (error) {
      this.#exclusions.push({
        ref,
        reason: ExclusionReason.UNREADABLE,
        details: { error: String(error) },
      });
      return;
    }

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

  /**
   * Map a ref back to a path on disk.
   *
   * Returns null for anything that resolves outside the source root. `makeRef`
   * already normalizes `..` away, so this is defence in depth against a ref
   * that arrived from somewhere else -- an imported corpus, or an MCP caller.
   */
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
