#!/usr/bin/env node
/**
 * Run GraphDog's evaluation suites.
 *
 *   npm run eval                                   every suite; gating ones against their baselines
 *   npm run eval -- --suite allganize-ja           one suite
 *   npm run eval -- --suite allganize-ja --json    the machine-readable report
 *   npm run eval -- --suite allganize-ja --record  re-record that suite's baseline
 *   npm run eval -- --suite allganize-ja --semantic  the same suite on a local
 *                                                    semantic model, compared
 *                                                    against no baseline
 *   npm run eval -- --list                         the suites there are
 *
 * Every other argument goes to `graphdog eval`.
 *
 * A suite is a directory under eval/suites/ with a suite.json naming its
 * corpus, its dataset and its baseline. A corpus is a directory of this
 * repository, optionally pinned by a lock of SHA-256s that every run checks: a
 * file that is missing, changed or unexpected stops the run, because numbers
 * from a different corpus are not comparable with the baseline.
 *
 * Each run builds its corpus afresh in a temporary workspace, so no index left
 * over from an earlier run can change the result.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";


const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "packages/cli/dist/main.js");
const SUITES = join(REPO, "eval", "suites");
const GATE_FAILED = 8;
const BASELINE_KEYS = ["recall_at_k", "precision_at_k", "mrr", "ndcg_at_k", "evidence_accuracy", "evidence_checked"];

function parseArguments(argv) {
  const options = { suite: null, record: false, list: false, semantic: false, passthrough: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--suite") options.suite = argv[++index] ?? null;
    else if (argument === "--record") options.record = true;
    else if (argument === "--list") options.list = true;
    // Build the suite's corpus with a local semantic model instead of the
    // built-in lexical one. A different configuration measures a different
    // thing, so it never compares against, or records, a baseline.
    else if (argument === "--semantic") options.semantic = true;
    // Paths given for the report are relative to the repository, not to the
    // temporary workspace the evaluation runs in.
    else if (!argument.startsWith("-") && argument.endsWith(".json")) options.passthrough.push(resolve(REPO, argument));
    else options.passthrough.push(argument);
  }
  return options;
}

async function loadSuites() {
  const suites = [];
  for (const name of (await readdir(SUITES)).sort()) {
    const directory = join(SUITES, name);
    try {
      const definition = JSON.parse(await readFile(join(directory, "suite.json"), "utf8"));
      suites.push({ ...definition, directory });
    } catch {
      // not a suite directory
    }
  }
  return suites;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `directory`, as paths relative to it with forward slashes. */
async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(directory, relative)));
    else files.push(relative);
  }
  return files;
}

/**
 * Copy the suite's corpus into `target`, and check it against its lock if it
 * has one. Every locked file must be present with its recorded SHA-256, and
 * nothing else may be there: numbers from a different corpus are not
 * comparable with the baseline, and saying so beats a quiet drift.
 */
async function materialize(suite, target) {
  const corpus = suite.corpus;
  if (corpus.kind !== "directory") throw new Error(`${suite.name}: unknown corpus kind ${JSON.stringify(corpus.kind)}`);
  await cp(join(REPO, corpus.path), target, { recursive: true });
  if (corpus.lock === undefined) return;

  const lock = JSON.parse(await readFile(join(suite.directory, corpus.lock), "utf8"));
  const expected = new Map(lock.documents.map((document) => [document.path.normalize("NFC"), document.sha256]));
  const problems = [];
  const present = new Set((await listFiles(target)).map((path) => path.normalize("NFC")));
  for (const [path, digest] of expected) {
    if (!present.has(path)) {
      problems.push(`${path}: missing`);
      continue;
    }
    if (sha256(await readFile(join(target, path))) !== digest) problems.push(`${path}: SHA-256 does not match the lock`);
  }
  for (const path of present) if (!expected.has(path)) problems.push(`${path}: not in the lock`);
  if (problems.length > 0) {
    throw new Error(
      `${suite.name}: the corpus does not match its lock, so its numbers would not be comparable ` +
        `with the baseline:\n  ${problems.join("\n  ")}`,
    );
  }
}

function graphdog(args, cwd, env, inherit) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

/** Recall, MRR and evidence per note component, e.g. per domain and per context type. */
function breakdown(report) {
  const groups = new Map();
  for (const query of report.queries) {
    if (query.note === null) continue;
    for (const part of query.note.split(" · ")) {
      if (!groups.has(part)) groups.set(part, []);
      groups.get(part).push(query.metrics);
    }
  }
  if (groups.size === 0) return "";
  const mean = (values) => {
    const measured = values.filter((value) => value !== null);
    return measured.length === 0 ? "--" : (measured.reduce((sum, value) => sum + value, 0) / measured.length).toFixed(3);
  };
  const lines = ["", "  by note:        queries  recall     mrr  evidence"];
  for (const [name, metrics] of [...groups].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const checked = metrics.reduce((sum, metric) => sum + metric.evidence_checked, 0);
    const correct = metrics.reduce((sum, metric) => sum + metric.evidence_correct, 0);
    lines.push(
      `  ${name.padEnd(16)}${String(metrics.length).padStart(7)}  ${mean(metrics.map((metric) => metric.recall_at_k)).padStart(6)}  ` +
        `${mean(metrics.map((metric) => metric.reciprocal_rank)).padStart(6)}  ${checked === 0 ? "--" : (correct / checked).toFixed(3)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function runSuite(suite, options) {
  const workspace = await mkdtemp(join(tmpdir(), `graphdog-eval-${suite.name}-`));
  const env = { ...process.env, GRAPHDOG_HOME: join(workspace, "home") };
  try {
    await materialize(suite, join(workspace, suite.corpus.source));

    const init = graphdog(
      ["init", suite.name, "--source", `./${suite.corpus.source}`, ...(options.semantic ? ["--semantic"] : [])],
      workspace,
      env,
      false,
    );
    if (init.status !== 0) throw new Error(`${suite.name}: init failed\n${init.stderr}`);
    const build = graphdog(["build", "--quiet"], workspace, env, false);
    // A partial build indexed a different corpus from the one the baseline
    // measured, so it is an error here rather than a warning.
    if (build.status !== 0) throw new Error(`${suite.name}: build failed (exit ${build.status})\n${build.stdout}${build.stderr}`);

    const baseline = join(suite.directory, suite.baseline);
    const explicitGate = options.passthrough.includes("--baseline") || options.passthrough.includes("--fail-under");
    let hasBaseline = false;
    try {
      await readFile(baseline);
      hasBaseline = true;
    } catch {
      hasBaseline = false;
    }
    const report = join(workspace, "report.json");
    const json = options.passthrough.includes("--json");
    const has = (flag) => options.passthrough.includes(flag);
    const args = [
      "eval",
      join(suite.directory, suite.dataset),
      // The corpus is the one this run just built, whatever the dataset's own
      // `corpus` field says.
      ...(has("--corpus") ? [] : ["--corpus", suite.name]),
      // A suite may set its own cutoff: with ten documents, recall@10 would be
      // 1.0 by construction and measure nothing.
      ...(suite.k === undefined || has("--top-k") || has("-k") ? [] : ["--top-k", String(suite.k)]),
      ...(hasBaseline && !options.record && !options.semantic && !has("--baseline")
        ? ["--baseline", baseline]
        : []),
      "--out",
      report,
      ...options.passthrough,
    ];
    if (!json) process.stdout.write(`\n== ${suite.name}${suite.gate ? "" : " (report only)"}: ${suite.description}\n\n`);
    const result = graphdog(args, workspace, env, true);
    if (result.status !== 0 && result.status !== GATE_FAILED) throw new Error(`${suite.name}: eval failed (exit ${result.status})`);

    // `--out` passed through sends the report somewhere else, and reading the
    // one this function asked for would then fail on a run that succeeded.
    const outIndex = options.passthrough.indexOf("--out");
    const actual = outIndex === -1 ? report : (options.passthrough[outIndex + 1] ?? report);
    const written = JSON.parse(await readFile(actual, "utf8"));

    // A search degrades gracefully when an optional part is missing, and says
    // so in a warning. An evaluation must not: a run that quietly measured
    // fusion order while reporting itself as a reranked one is worse than no
    // number, because it compares against a baseline and passes.
    const degraded = (written.warnings ?? []).find((warning) => warning.code === "rerank_unavailable");
    if (has("--rerank") && degraded !== undefined) {
      throw new Error(`${suite.name}: --rerank was asked for and no reranker ran: ${degraded.message}`);
    }
    if (!json) process.stdout.write(breakdown(written));

    if (options.record && options.semantic) {
      throw new Error("--record writes the baseline for the shipped configuration; drop --semantic");
    }
    if (options.record) {
      let previous = {};
      try {
        previous = JSON.parse(await readFile(baseline, "utf8"));
      } catch {
        previous = {};
      }
      const summary = Object.fromEntries(BASELINE_KEYS.map((key) => [key, written.summary[key]]));
      await writeFile(baseline, `${JSON.stringify({ ...previous, summary }, null, 2)}\n`);
      if (!json) process.stdout.write(`\n  recorded ${suite.baseline}\n`);
      return 0;
    }
    if (result.status === GATE_FAILED && !suite.gate && !explicitGate) {
      if (!json) process.stdout.write("  (moved against its baseline; this suite reports, it does not gate)\n");
      return 0;
    }
    return result.status;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const suites = await loadSuites();
  if (options.list) {
    for (const suite of suites) console.log(`${suite.name.padEnd(16)}${suite.gate ? "gate  " : "report"}  ${suite.description}`);
    return 0;
  }
  const chosen = options.suite === null ? suites : suites.filter((suite) => suite.name === options.suite);
  if (chosen.length === 0) throw new Error(`no suite named ${JSON.stringify(options.suite)}; try --list`);
  if (chosen.length > 1 && (options.passthrough.includes("--json") || options.record)) {
    throw new Error("--json and --record apply to one suite at a time; add --suite <name>");
  }
  let exitCode = 0;
  for (const suite of chosen) {
    const status = await runSuite(suite, options);
    if (status !== 0) exitCode = status;
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`run-eval: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
