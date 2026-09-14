/**
 * Runs the real CLI in a subprocess and parses its `--json` output.
 *
 * A subprocess rather than an in-process call on purpose: the equivalence claim
 * is about what the two *shipped* entry points return, so the test should go
 * through argument parsing, rendering and stdout exactly as a user would.
 *
 * Excluded from the published build.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The built CLI entry point, relative to this file inside the monorepo. */
function cliEntryPoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "cli", "dist", "main.js");
}

async function runCli(cwd: string, args: readonly string[]): Promise<unknown> {
  const { stdout } = await run(process.execPath, [cliEntryPoint(), ...args, "--json"], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function runSearchForTest(cwd: string, args: readonly string[]): Promise<unknown> {
  return runCli(cwd, ["search", ...args]);
}

export async function runReadForTest(cwd: string, args: readonly string[]): Promise<unknown> {
  return runCli(cwd, ["read", ...args]);
}

export { cliEntryPoint };
