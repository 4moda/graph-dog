/**
 * Source and extraction ports.
 *
 * A source answers "which files are content here", and an extractor answers
 * "what text is in this file". Splitting them keeps format support orthogonal
 * to where documents come from: adding Confluence does not touch the PDF
 * reader, and adding PDF support does not touch the git walker.
 */

export interface SourceSpec {
  readonly id: string;
  readonly kind: string;
  readonly uri: string;
  /** Glob patterns; empty means every supported file type. */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maxFileBytes: number;
  readonly followSymlinks: boolean;
  /** Opt-in escape hatch for indexing files that match the secret patterns. */
  readonly indexSecrets: boolean;
}

export interface DiscoveredFile {
  /** Portable identity: `<source-id>/<posix-relative-path>`. */
  readonly ref: string;
  /** Absolute path on this machine. Never leaves the infrastructure layer. */
  readonly absolutePath: string;
  readonly size: number;
  readonly mtime: number;
}

export interface SourceExclusion {
  readonly ref: string;
  readonly reason: string;
  readonly details: Record<string, unknown>;
}

export interface SourceReader {
  readonly spec: SourceSpec;
  /** Current revision, e.g. a git commit SHA. Null for unversioned sources. */
  revision(): string | null;
  /** Candidate files, in a deterministic order. */
  discover(): DiscoveredFile[];
  /** What the last `discover` skipped, and why. Surfaced in the build report. */
  exclusions(): SourceExclusion[];
  /** Map a ref back to a path, refusing anything that escapes the source root. */
  resolve(ref: string): string | null;
}

export interface ExtractedDocument {
  /** The complete extracted text. Never truncated: truncation loses evidence. */
  readonly text: string;
  readonly title: string;
  readonly mediaType: string;
  /** `[charOffset, pageNumber]` for paginated formats; empty otherwise. */
  readonly pageBreaks: ReadonlyArray<readonly [number, number]>;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  /** Non-fatal notes, e.g. "3 pages had no text layer". Surfaced as warnings. */
  readonly notes: readonly string[];
}

export interface ContentExtractor {
  /** Extensions this extractor claims, lowercase and dot-prefixed. */
  readonly extensions: ReadonlySet<string>;
  readonly name: string;
  extract(absolutePath: string): Promise<ExtractedDocument>;
}

export interface ExtractorRegistry {
  supports(extension: string): boolean;
  supportedExtensions(): ReadonlySet<string>;
  /** Extract, or throw `ExtractionError` naming why this file could not be read. */
  extract(absolutePath: string): Promise<ExtractedDocument>;
}
