#!/usr/bin/env node
/**
 * Move a dataset's judged line ranges to where that text is now.
 *
 * The `graphdog-docs` suite judges passages of this repository's own design
 * documents, so editing the documents moves every judgment under it. That is a
 * known reason it reports rather than gates -- but a report whose judgments
 * point at the wrong lines is not a report, it is noise, and it stops anyone
 * telling a real citation regression from a paragraph that moved.
 *
 * This is relocation, not re-judging: it takes the passage a judgment pointed
 * at in the commit where the dataset was last correct, finds that same passage
 * in the working tree, and writes the new range. A passage it cannot find
 * confidently is **reported, never guessed** -- that one needs a person to
 * decide whether the document still answers the question at all.
 *
 *   node scripts/relocate-judgments.mjs <dataset.json> <since-commit> [--write]
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const [dataset, since, ...rest] = process.argv.slice(2);
const write = rest.includes("--write");

if (dataset === undefined || since === undefined) {
  process.stderr.write("usage: relocate-judgments.mjs <dataset.json> <since-commit> [--write]\n");
  process.exit(2);
}

/** A file as it was at `since`, or null when it did not exist then. */
function at(commit, path) {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function parseRange(lines) {
  const [from, to] = String(lines).split("-").map(Number);
  return from === undefined || Number.isNaN(from) ? null : { from, to: Number.isNaN(to ?? NaN) ? from : (to ?? from) };
}

/** Lines that carry enough text to identify a passage; blank and heading-only lines do not. */
const distinctive = (line) => line.trim().length >= 25;

/**
 * Where `passage` sits in `current`, as a 1-based inclusive range.
 *
 * Anchored on the passage's distinctive lines: the window whose content most
 * of them fall inside. Requires a clear majority, so a passage that was
 * rewritten rather than moved comes back unmatched instead of pointing
 * somewhere plausible and wrong.
 */
function locate(passage, current) {
  const wanted = passage.split("\n").filter(distinctive).map((line) => line.trim());
  if (wanted.length === 0) return null;

  const lines = current.split("\n");
  const found = [];
  for (const line of wanted) {
    const index = lines.findIndex((candidate) => candidate.trim() === line);
    if (index !== -1) found.push(index + 1);
  }
  if (found.length < Math.ceil(wanted.length * 0.6)) return null;

  const from = Math.min(...found);
  const to = Math.max(...found);
  // A passage scattered over far more lines than it occupied is not that
  // passage; it is the same sentences reused in several places.
  if (to - from > (passage.split("\n").length + 10) * 2) return null;
  return { from, to };
}

const data = JSON.parse(await readFile(dataset, "utf8"));
const report = [];
let moved = 0;
let unchanged = 0;
let unmatched = 0;

for (const query of data.queries) {
  for (const judgment of query.relevant ?? []) {
    const range = parseRange(judgment.lines);
    if (range === null) continue;

    const before = at(since, judgment.ref);
    const current = await readFile(judgment.ref, "utf8").catch(() => null);
    if (before === null || current === null) {
      report.push(`  ${query.id} ${judgment.ref}: file missing at ${since} or now`);
      unmatched += 1;
      continue;
    }

    const passage = before.split("\n").slice(range.from - 1, range.to).join("\n");
    const now = locate(passage, current);
    if (now === null) {
      report.push(`  ${query.id} ${judgment.ref}:${judgment.lines} -> NOT FOUND (rewritten? re-judge by hand)`);
      unmatched += 1;
      continue;
    }

    const next = `${now.from}-${now.to}`;
    if (next === judgment.lines) {
      unchanged += 1;
      continue;
    }
    report.push(`  ${query.id} ${judgment.ref}: ${judgment.lines} -> ${next}`);
    judgment.lines = next;
    moved += 1;
  }
}

process.stdout.write(`${report.join("\n")}\n\n`);
process.stdout.write(`  ${unchanged} unchanged, ${moved} moved, ${unmatched} not found\n`);

if (write && unmatched === 0) {
  await writeFile(dataset, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(`  wrote ${dataset}\n`);
} else if (write) {
  process.stdout.write("  nothing written: relocate what is left by hand first\n");
  process.exit(1);
}
