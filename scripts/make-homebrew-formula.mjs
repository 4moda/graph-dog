#!/usr/bin/env node
/**
 * Print the Homebrew formula for a published version.
 *
 * The SHA-256 is fetched from the npm registry rather than typed, because a
 * formula with a stale checksum fails for every user at once and the mistake is
 * invisible in review.
 *
 *   node scripts/make-homebrew-formula.mjs 0.2.0 > packaging/homebrew/graphdog.rb
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
  process.stderr.write("usage: make-homebrew-formula.mjs <version>\n");
  process.exit(2);
}

const metadata = await fetch(`https://registry.npmjs.org/graphdog/${version}`);
if (!metadata.ok) {
  process.stderr.write(`graphdog ${version} is not published (${metadata.status})\n`);
  process.exit(3);
}

const { dist } = await metadata.json();
const tarball = dist?.tarball;
if (typeof tarball !== "string") {
  process.stderr.write("the registry returned no tarball URL\n");
  process.exit(3);
}

// `dist.integrity` is base64 SHA-512; Homebrew wants hex SHA-256, so hash the
// tarball itself rather than converting something that is not the same digest.
const { createHash } = await import("node:crypto");
const bytes = new Uint8Array(await (await fetch(tarball)).arrayBuffer());
const sha256 = createHash("sha256").update(bytes).digest("hex");

const template = await readFile(join(root, "packaging", "homebrew", "graphdog.rb"), "utf8");
process.stdout.write(
  template
    .replace(/url "[^"]*"/, `url "${tarball}"`)
    .replace(/sha256 "[^"]*"/, `sha256 "${sha256}"`),
);
