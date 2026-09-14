#!/usr/bin/env node
/**
 * Run GraphDog's evaluation dataset against GraphDog's own design docs.
 *
 * Dogfooding on purpose: the docs are the only corpus that ships with the
 * repository, so this is the one measurement anybody can reproduce from a
 * clean checkout with no data of their own. It is small, so treat it as a
 * regression tripwire rather than as evidence that retrieval is good.
 *
 *   npm run eval                        # print the report
 *   npm run eval -- --json              # the machine-readable contract
 *   npm run eval -- --out eval/baseline.json
 *   npm run eval -- --baseline eval/baseline.json
 *
 * Everything after `--` is passed through to `graphdog eval`.
 */

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "packages/cli/dist/main.js");
const dataset = join(repo, "eval/graphdog-docs.json");

// Built in a temporary workspace so the repository never gains an index, and
// so a stale corpus from a previous run cannot silently change the numbers.
const workspace = await mkdtemp(join(tmpdir(), "graphdog-eval-"));

function graphdog(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    stdio: options.quiet === true ? ["ignore", "ignore", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  await cp(join(repo, "docs"), join(workspace, "docs"), { recursive: true });

  if (graphdog(["init", "graphdog", "--source", "./docs"], { quiet: true }) !== 0) {
    throw new Error("could not create the evaluation corpus");
  }
  if (graphdog(["build", "--quiet"], { quiet: true }) !== 0) {
    throw new Error("could not build the evaluation corpus");
  }

  // The dataset's paths are relative to the corpus, and any extra argument the
  // caller passed (--baseline, --out) is relative to the repository, so both
  // are resolved here rather than inside the temporary workspace.
  const passthrough = process.argv.slice(2).map((argument) => {
    if (!argument.startsWith("-") && argument.endsWith(".json")) return resolve(repo, argument);
    return argument;
  });

  process.exitCode = graphdog([ "eval", dataset, ...passthrough ]);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
