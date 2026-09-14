/**
 * The shape every CLI command returns.
 *
 * A command produces *both* renderings and lets `main` pick, rather than
 * printing directly. That keeps the choice of `--json` out of command logic and
 * makes it impossible for a command to emit prose into a JSON stream.
 */

import type { ExitCodeValue, Logger } from "@graphdog/core";

import type { ParsedCommand } from "../../infrastructure/argv.ts";

export interface CommandContext {
  readonly parsed: ParsedCommand;
  readonly cwd: string;
  readonly logger: Logger;
  readonly json: boolean;
}

export interface CommandResult {
  /** The contract object, emitted verbatim under `--json`. */
  readonly json: unknown;
  /** Prose for a terminal. Never parsed by anything. */
  readonly human: string;
  /** Non-zero for outcomes a caller must branch on, e.g. partial builds. */
  readonly exitCode?: ExitCodeValue;
}
