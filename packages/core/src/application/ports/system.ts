/**
 * Ambient-capability ports.
 *
 * Time and hashing are injected rather than imported so that use cases stay
 * deterministic under test: a build report's timestamps and a chunk's id are
 * both things tests need to pin down.
 */

export interface Clock {
  /** Current time as an ISO-8601 string. */
  nowIso(): string;
  /** Monotonic milliseconds, for measuring elapsed time. */
  monotonicMs(): number;
}

export interface Hasher {
  /** Hex digest of a string. Used for chunk ids and fingerprints. */
  hashText(input: string): string;
  /** Hex digest of bytes. Used for file content hashes and archive checksums. */
  hashBytes(input: Uint8Array): string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Progress and diagnostics sink.
 *
 * Never `stdout`: the CLI writes JSON there and the MCP server speaks JSON-RPC
 * there. Implementations must write to stderr or discard.
 */
export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

export const SILENT_LOGGER: Logger = { log: () => undefined };
