/**
 * Domain and application errors.
 *
 * Design principle: *an error is never reported as success*. Every failure a
 * caller might branch on gets a stable `code` string and a process exit code,
 * so an agent can react without parsing prose.
 *
 * This file sits in the domain layer because the error taxonomy is part of the
 * domain language, not a delivery detail. Nothing here touches IO.
 */

export const ExitCode = {
  /** Completed as asked. */
  OK: 0,
  /** Unexpected or internal failure. */
  ERROR: 1,
  /** Bad arguments or unusable configuration. */
  USAGE: 2,
  /** Corpus, source, ref or chunk does not exist. */
  NOT_FOUND: 3,
  /** Schema, embedding or chunking identity mismatch. Refuse rather than guess. */
  INCOMPATIBLE: 4,
  /** Build finished, but some files failed. */
  PARTIAL: 5,
  /** Target already exists, or was modified concurrently. */
  CONFLICT: 6,
  /** The query ran and nothing cleared the evidence threshold. */
  NO_EVIDENCE: 7,
  /** An evaluation ran and breached a threshold or regressed against a baseline. */
  GATE_FAILED: 8,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface ErrorPayload {
  error: { code: string; message: string; details: Record<string, unknown> };
}

export class GraphDogError extends Error {
  readonly code: string = "error";
  readonly exitCode: ExitCodeValue = ExitCode.ERROR;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }

  toJSON(): ErrorPayload {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class UsageError extends GraphDogError {
  override readonly code: string = "usage";
  override readonly exitCode: ExitCodeValue = ExitCode.USAGE;
}

export class ConfigError extends GraphDogError {
  override readonly code: string = "config_invalid";
  override readonly exitCode: ExitCodeValue = ExitCode.USAGE;
}

export class NotFoundError extends GraphDogError {
  override readonly code: string = "not_found";
  override readonly exitCode: ExitCodeValue = ExitCode.NOT_FOUND;
}

export class CorpusNotFoundError extends NotFoundError {
  override readonly code: string = "corpus_not_found";
}

export class RefNotFoundError extends NotFoundError {
  override readonly code: string = "ref_not_found";
}

/**
 * The corpus cannot be queried as it stands.
 *
 * Searching a corpus whose vectors came from a different model returns
 * confident nonsense, so this is refused loudly instead of degrading.
 */
export class IncompatibleCorpusError extends GraphDogError {
  override readonly code: string = "incompatible_corpus";
  override readonly exitCode: ExitCodeValue = ExitCode.INCOMPATIBLE;
}

export class ConflictError extends GraphDogError {
  override readonly code: string = "conflict";
  override readonly exitCode: ExitCodeValue = ExitCode.CONFLICT;
}

export class ArchiveError extends GraphDogError {
  override readonly code: string = "archive_invalid";
}

/** Raised per file during a build, then collected into failures rather than aborting. */
export class ExtractionError extends GraphDogError {
  override readonly code: string = "extraction_failed";
}

export function isGraphDogError(value: unknown): value is GraphDogError {
  return value instanceof GraphDogError;
}

/** Normalize anything thrown into a reportable error, preserving the stack. */
export function toGraphDogError(value: unknown): GraphDogError {
  if (isGraphDogError(value)) return value;
  if (value instanceof Error) {
    const wrapped = new GraphDogError(value.message, { cause: value.name });
    wrapped.stack = value.stack;
    return wrapped;
  }
  return new GraphDogError(String(value));
}
