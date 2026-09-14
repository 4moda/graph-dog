/**
 * Real implementations of the ambient-capability ports.
 *
 * These are trivial, which is the point: time and hashing are injected so use
 * cases can be made deterministic under test, and that only works if the real
 * versions stay thin enough to be obviously equivalent.
 */

import { createHash } from "node:crypto";

import type { Clock, Hasher, LogLevel, Logger } from "../application/ports/system.ts";

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  // `performance.now` rather than `Date.now`: elapsed time must not jump when
  // the wall clock is adjusted mid-build.
  monotonicMs: () => performance.now(),
};

export const sha256Hasher: Hasher = {
  hashText: (input) => createHash("sha256").update(input, "utf8").digest("hex"),
  hashBytes: (input) => createHash("sha256").update(input).digest("hex"),
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logger writing to stderr.
 *
 * Never stdout: the CLI writes JSON there and the MCP server speaks JSON-RPC
 * there, so a stray log line would corrupt a machine-readable stream.
 */
export function createStderrLogger(minimum: LogLevel = "info"): Logger {
  const threshold = LEVEL_ORDER[minimum];
  return {
    log(level, message, fields) {
      if (LEVEL_ORDER[level] < threshold) return;
      const suffix =
        fields === undefined || Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
      process.stderr.write(`graphdog ${level}: ${message}${suffix}\n`);
    },
  };
}
