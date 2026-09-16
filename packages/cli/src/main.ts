/**
 * The CLI composition root.
 *
 * Responsibilities, deliberately narrow: route to a command, pick a rendering,
 * write to the right stream, and map an error onto an exit code. It contains no
 * retrieval logic at all, which is what lets the MCP server reuse the same use
 * cases without reimplementing anything.
 *
 * Stream discipline matters here. Results go to stdout; progress and warnings
 * go to stderr. That is what makes `graphdog search --json | jq` work while a
 * human still sees what is happening.
 */

import process from "node:process";

/**
 * Silence Node's experimental warning for `node:sqlite`.
 *
 * The built-in driver is what keeps the default install free of native build
 * steps, but its warning writes to stderr on every invocation -- noise in a
 * terminal, and clutter in the logs of anything that shells out to this CLI.
 * Only that one warning is suppressed; everything else still surfaces.
 */
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && text.includes("SQLite")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

import { ExitCode, UsageError, createStderrLogger, toGraphDogError, type ExitCodeValue, type Logger } from "@graphdog/core";

import { VERSION } from "./version.ts";
import {
  parseCommandLine,
  renderCommandHelp,
  optionBoolean,
  type CommandSpec,
  type ParsedCommand,
} from "./infrastructure/argv.ts";
import { renderJson } from "./infrastructure/render/json-renderer.ts";
import { renderError } from "./infrastructure/render/human-renderer.ts";
import type { CommandContext, CommandResult } from "./application/commands/types.ts";
import { initSpec, runInit } from "./application/commands/init.ts";
import { addSpec, runAdd } from "./application/commands/add.ts";
import { buildSpec, runBuild, updateSpec } from "./application/commands/build.ts";
import { exploreSpec, runSearch, searchSpec } from "./application/commands/search.ts";
import { readSpec, runRead } from "./application/commands/read.ts";
import { listSpec, runList, runStatus, statusSpec } from "./application/commands/status.ts";
import { evalSpec, runEval } from "./application/commands/eval.ts";
import { exportSpec, importSpec, runExport, runImport } from "./application/commands/archive.ts";
import {
  installSpec,
  runInstall,
  runUninstall,
  uninstallSpec,
} from "./application/commands/install.ts";

type CommandHandler = (context: CommandContext) => Promise<CommandResult>;

interface Command {
  readonly spec: CommandSpec;
  readonly run: CommandHandler;
}

const COMMANDS: readonly Command[] = [
  { spec: initSpec, run: runInit },
  { spec: addSpec, run: runAdd },
  { spec: buildSpec, run: (context) => runBuild(context, true) },
  { spec: updateSpec, run: (context) => runBuild(context, false) },
  { spec: searchSpec, run: (context) => runSearch(context, "search") },
  { spec: exploreSpec, run: (context) => runSearch(context, "explore") },
  { spec: readSpec, run: runRead },
  { spec: statusSpec, run: runStatus },
  { spec: listSpec, run: runList },
  { spec: evalSpec, run: runEval },
  { spec: exportSpec, run: runExport },
  { spec: importSpec, run: runImport },
  { spec: installSpec, run: runInstall },
  { spec: uninstallSpec, run: runUninstall },
];

/**
 * Where output goes.
 *
 * Injected rather than referencing `process` directly so the router can be
 * driven from a test without monkey-patching global streams -- which, among
 * other things, swallows the test runner's own output.
 */
export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const processStreams: Streams = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  streams: Streams = processStreams,
): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    streams.out(renderTopLevelHelp());
    return ExitCode.OK;
  }
  if (name === "--version" || name === "-V" || name === "version") {
    streams.out(`${VERSION}\n`);
    return ExitCode.OK;
  }

  const command = COMMANDS.find((candidate) => candidate.spec.name === name);
  if (command === undefined) {
    const error = new UsageError(`unknown command "${name}"`, {
      available: COMMANDS.map((candidate) => candidate.spec.name),
      hint: "run 'graphdog --help' to see every command",
    });
    return reportError(error, false, streams);
  }

  let parsed: ParsedCommand;
  try {
    parsed = parseCommandLine(rest, command.spec);
  } catch (error) {
    return reportError(toGraphDogError(error), false, streams);
  }

  if (optionBoolean(parsed, "help")) {
    streams.out(renderCommandHelp(command.spec));
    return ExitCode.OK;
  }

  const json = optionBoolean(parsed, "json");
  const logger = createLogger(parsed, json);

  try {
    const result = await command.run({ parsed, cwd: process.cwd(), logger, json });
    streams.out(json ? renderJson(result.json) : result.human);
    return result.exitCode ?? ExitCode.OK;
  } catch (error) {
    return reportError(toGraphDogError(error), json, streams);
  }
}

/**
 * Choose a log destination.
 *
 * Under `--json` the default is to stay quiet: a caller parsing stdout usually
 * does not want progress chatter on stderr either, and `--verbose` is there
 * when they do.
 */
function createLogger(parsed: ParsedCommand, json: boolean): Logger {
  if (optionBoolean(parsed, "verbose")) return createStderrLogger("debug");
  if (optionBoolean(parsed, "quiet")) return createStderrLogger("error");
  return createStderrLogger(json ? "warn" : "info");
}

/**
 * Report a failure and map it to an exit code.
 *
 * Errors always go to stderr, in both modes -- including under `--json`, where
 * stdout must stay a clean stream of contract objects. The machine-readable
 * error envelope is written to stderr rather than stdout for the same reason.
 */
function reportError(
  error: ReturnType<typeof toGraphDogError>,
  json: boolean,
  streams: Streams,
): ExitCodeValue {
  streams.err(
    json ? renderJson(error.toJSON()) : renderError(error.code, error.message, error.details),
  );
  return error.exitCode;
}

function renderTopLevelHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.spec.name.length)) + 4;
  const lines = [
    `graphdog ${VERSION} -- agent-native portable knowledge index`,
    "",
    "Usage: graphdog <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map(
      (command) => `  ${command.spec.name.padEnd(width)}${command.spec.summary}`,
    ),
    "",
    "Getting started:",
    "  graphdog init docs --source ./docs",
    "  graphdog build",
    '  graphdog search "your question"',
    "",
    "Every command accepts --json for machine-readable output, and --help for details.",
    "",
    "Exit codes:",
    "  0 ok   2 usage   3 not found   4 incompatible corpus   5 partial build   7 no evidence   8 eval gate failed",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

// Only run when executed as a program, so the module stays importable by tests.
if (process.argv[1] !== undefined && import.meta.url.endsWith(baseName(process.argv[1]))) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`graphdog: unexpected failure: ${String(error)}\n`);
      process.exitCode = ExitCode.ERROR;
    });
}

function baseName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? path : path.slice(separator + 1);
}
