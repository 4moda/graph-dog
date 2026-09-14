import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExitCode } from "@graphdog/core";

import { parseCommandLine } from "../../infrastructure/argv.ts";
import { SILENT } from "./__fixtures__/cli-harness.ts";
import type { CommandContext, CommandResult } from "./types.ts";

/**
 * `CommandResult` is the shape that keeps rendering out of command logic. What
 * is worth pinning is the invariant it exists to enforce: a command produces
 * both renderings and never decides which one is printed.
 */
describe("cli/application/commands/types", () => {
  const spec = {
    name: "demo",
    summary: "s",
    usage: "u",
    options: {},
  };

  it("carries a machine payload and a human rendering side by side", () => {
    const result: CommandResult = { json: { kind: "demo" }, human: "done\n" };
    assert.equal((result.json as { kind: string }).kind, "demo");
    assert.equal(result.human, "done\n");
  });

  it("treats a missing exit code as success", () => {
    const result: CommandResult = { json: {}, human: "" };
    assert.equal(result.exitCode ?? ExitCode.OK, ExitCode.OK);
  });

  it("can signal a non-zero outcome without throwing", () => {
    // A partial build and an empty search are real outcomes, not failures, so
    // they carry a code rather than raising.
    const partial: CommandResult = { json: {}, human: "", exitCode: ExitCode.PARTIAL };
    assert.equal(partial.exitCode, ExitCode.PARTIAL);
  });

  it("records whether the caller asked for JSON", () => {
    const context: CommandContext = {
      parsed: parseCommandLine(["--json"], spec),
      cwd: "/tmp",
      logger: SILENT,
      json: true,
    };
    assert.equal(context.json, true);
  });
});
