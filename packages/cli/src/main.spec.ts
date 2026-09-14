import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ExitCode } from "@graphdog/core";

import { main } from "./main.ts";

/** Run `main` with its output captured, without touching the global streams. */
async function invoke(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("cli/main", () => {
  describe("help and version", () => {
    it("prints help with no arguments", async () => {
      const { code, out } = await invoke([]);
      assert.equal(code, ExitCode.OK);
      assert.match(out, /Usage: graphdog <command>/);
    });

    it("lists every command", async () => {
      const { out } = await invoke(["--help"]);
      for (const command of ["init", "add", "build", "update", "search", "explore", "read", "status", "list"]) {
        assert.match(out, new RegExp(`\\b${command}\\b`), `${command} should be listed`);
      }
    });

    it("documents the exit codes an agent branches on", async () => {
      const { out } = await invoke(["--help"]);
      assert.match(out, /7 no evidence/);
      assert.match(out, /4 incompatible/);
    });

    it("prints the version", async () => {
      const { code, out } = await invoke(["--version"]);
      assert.equal(code, ExitCode.OK);
      assert.match(out, /^\d+\.\d+\.\d+\n$/);
    });

    it("prints per-command help", async () => {
      const { code, out } = await invoke(["search", "--help"]);
      assert.equal(code, ExitCode.OK);
      assert.match(out, /graphdog search/);
      assert.match(out, /--top-k/);
    });
  });

  describe("errors", () => {
    it("rejects an unknown command and lists the real ones", async () => {
      const { code, err } = await invoke(["frobnicate"]);
      assert.equal(code, ExitCode.USAGE);
      assert.match(err, /unknown command "frobnicate"/);
      assert.match(err, /available: /);
    });

    it("writes errors to stderr, never stdout", async () => {
      const { out, err } = await invoke(["frobnicate"]);
      assert.equal(out, "", "stdout must stay a clean stream of results");
      assert.ok(err.length > 0);
    });

    it("keeps stdout clean under --json too", async () => {
      // A caller piping stdout to a parser must never receive an error there.
      const { out, err } = await invoke(["search", "--json"]);
      assert.equal(out, "");
      assert.doesNotThrow(() => JSON.parse(err), "the error envelope should still be JSON");
    });

    it("rejects an unknown option rather than ignoring it", async () => {
      const { code, err } = await invoke(["search", "--sorce", "x"]);
      assert.equal(code, ExitCode.USAGE);
      assert.match(err, /error \[usage\]/);
    });

    it("reports a missing corpus with the not-found code", async () => {
      const { code } = await invoke(["status", "--corpus", "definitely-not-a-real-corpus"]);
      assert.equal(code, ExitCode.NOT_FOUND);
    });
  });

  describe("streams", () => {
    it("writes results to stdout", async () => {
      const { out } = await invoke(["--help"]);
      assert.ok(out.length > 0);
    });
  });
});
