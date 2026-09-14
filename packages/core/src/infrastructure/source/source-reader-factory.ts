/**
 * Constructing a source reader from its spec.
 *
 * The registry is a plain map so a future adapter (Confluence, GitLab wiki, an
 * HTTP crawl) is one entry plus one class, with nothing else to change.
 */

import { ConfigError } from "../../domain/errors.ts";
import type { SourceReader, SourceSpec } from "../../application/ports/sources.ts";
import { GitSourceReader } from "./git-source-reader.ts";
import { LocalSourceReader } from "./local-source-reader.ts";
import { DEFAULT_MAX_FILE_BYTES } from "./exclusion-policy.ts";

export type SourceKind = "local" | "git";

export const SUPPORTED_SOURCE_KINDS: readonly SourceKind[] = ["local", "git"];

export function buildSourceReader(
  spec: SourceSpec,
  supportedExtensions: ReadonlySet<string>,
): SourceReader {
  switch (spec.kind) {
    case "local":
      return new LocalSourceReader(spec, supportedExtensions);
    case "git":
      return new GitSourceReader(spec, supportedExtensions);
    default:
      throw new ConfigError(`unknown source kind: ${spec.kind}`, {
        supported: SUPPORTED_SOURCE_KINDS,
        source_id: spec.id,
      });
  }
}

/** Fill in defaults for a partially specified source. */
export function normalizeSourceSpec(input: {
  id: string;
  kind?: string;
  uri: string;
  include?: readonly string[];
  exclude?: readonly string[];
  maxFileBytes?: number;
  followSymlinks?: boolean;
  indexSecrets?: boolean;
}): SourceSpec {
  if (input.id === "" || input.id.includes("/") || input.id.startsWith(".")) {
    throw new ConfigError(
      `invalid source id ${JSON.stringify(input.id)}: it becomes the first path segment of ` +
        `every ref, so it must be non-empty and contain no '/'`,
    );
  }
  return {
    id: input.id,
    kind: input.kind ?? "local",
    uri: input.uri,
    include: input.include ?? [],
    exclude: input.exclude ?? [],
    maxFileBytes: input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    followSymlinks: input.followSymlinks ?? false,
    indexSecrets: input.indexSecrets ?? false,
  };
}
