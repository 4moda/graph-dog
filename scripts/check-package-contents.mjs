#!/usr/bin/env node
/**
 * Check what `npm publish` would actually send, before it sends it.
 *
 * Two things went wrong here once and would have gone unnoticed:
 *
 * - **Test code shipped.** `npm run build` excludes the specs; `npm run
 *   typecheck` does not, and both emit into the same `dist/`. Whichever ran
 *   last decided what `files` picked up, and 411 spec and fixture files went
 *   into the tarballs.
 * - **A `bin` without its shebang.** The build adds one after `tsc`; a
 *   typecheck emitting afterwards took it off again, leaving an entry point
 *   npm would link and nothing could execute.
 *
 * `prepack` now rebuilds before either can happen. This checks the result,
 * because a packaging fault is invisible until it is on the registry, where it
 * cannot be taken back -- only superseded.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["packages/core", "packages/mcp", "packages/cli"];

/** Nothing matching these belongs in a published tarball. */
const FORBIDDEN = [/\.spec\./, /__fixtures__/, /tsbuildinfo/, /\.ts$(?<!\.d\.ts)/];

const problems = [];

for (const directory of packages) {
  const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
  const listing = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--workspace", directory], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );

  const entry = Array.isArray(listing) ? listing[0] : listing;
  const files = (entry?.files ?? []).map((file) => file.path);
  if (files.length === 0) {
    problems.push(`${manifest.name}: npm pack reported no files at all`);
    continue;
  }

  for (const file of files) {
    if (FORBIDDEN.some((pattern) => pattern.test(file))) {
      problems.push(`${manifest.name}: would publish ${file}`);
    }
  }

  // Every declared bin has to be there, and has to start with a shebang, or
  // npm links a command that cannot run.
  for (const [command, relative] of Object.entries(manifest.bin ?? {})) {
    if (!files.includes(relative)) {
      problems.push(`${manifest.name}: bin "${command}" points at ${relative}, which is not in the tarball`);
      continue;
    }
    const first = readFileSync(join(root, directory, relative), "utf8").split("\n", 1)[0] ?? "";
    if (!first.startsWith("#!")) {
      problems.push(`${manifest.name}: bin "${command}" (${relative}) has no shebang, it starts "${first.slice(0, 20)}"`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.stderr.write("\nrun 'npm run build' and try again\n");
  process.exit(1);
}

process.stdout.write(`${packages.length} package(s) would publish nothing they should not\n`);
