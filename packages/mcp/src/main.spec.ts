import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExitCode } from "@graphdog/core";

import { main } from "./main.ts";

/**
 * `main` starts a long-lived stdio server, so the paths worth testing are the
 * ones that return without connecting: help, version, and argument errors.
 * Serving behaviour is covered against an in-memory transport in the server's
 * own spec.
 */
async function invoke(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe("mcp/main", () => {
  it("prints usage", async () => {
    const { code, out } = await invoke(["--help"]);
    assert.equal(code, ExitCode.OK);
    assert.match(out, /graphdog-mcp/);
    assert.match(out, /--allow-write/);
  });

  it("documents how to wire it into an MCP host", async () => {
    const { out } = await invoke(["--help"]);
    assert.match(out, /mcpServers/);
  });

  it("prints the version", async () => {
    const { code, out } = await invoke(["--version"]);
    assert.equal(code, ExitCode.OK);
    assert.match(out, /^\d+\.\d+\.\d+\n$/);
  });

  it("rejects an unknown option with the usage code", async () => {
    const { code, err } = await invoke(["--nonsense"]);
    assert.equal(code, ExitCode.USAGE);
    assert.match(err, /graphdog-mcp/);
  });
});
