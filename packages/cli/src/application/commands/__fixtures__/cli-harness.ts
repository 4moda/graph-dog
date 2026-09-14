/**
 * A harness for driving commands the way `main` does.
 *
 * Commands are exercised through the real argument parser and a real workspace
 * on disk, so a spec covers the same path a user takes. Only the streams are
 * substituted. Excluded from the published build.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Logger } from "@graphdog/core";

import { parseCommandLine, type CommandSpec } from "../../../infrastructure/argv.ts";
import type { CommandContext, CommandResult } from "../types.ts";

export const SILENT: Logger = { log: () => undefined };

export async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "graphdog-cli-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

export async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** Run one command with the given argv, in the given directory. */
export async function run(
  spec: CommandSpec,
  handler: (context: CommandContext) => Promise<CommandResult>,
  cwd: string,
  argv: readonly string[],
): Promise<CommandResult> {
  const parsed = parseCommandLine(argv, spec);
  return handler({
    parsed,
    cwd,
    logger: SILENT,
    json: parsed.options["json"] === true,
  });
}

export const FIXTURE_DOCS: Record<string, string> = {
  "docs/token.md": [
    "---",
    "title: Access Token",
    "tags: [auth, jwt]",
    "---",
    "",
    "# Access Token",
    "",
    "Access tokens are issued as JWT values signed with ES256.",
    "",
    "## Rotation",
    "",
    "Tokens expire after one hour. See [key management](keys.md).",
    "",
  ].join("\n"),
  "docs/keys.md": [
    "---",
    "title: Key Management",
    "tags: [auth, jwks]",
    "---",
    "",
    "# Key Management",
    "",
    "Public keys are published at the JWKS endpoint.",
    "",
  ].join("\n"),
};
