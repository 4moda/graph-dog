/**
 * `graphdog-mcp` -- the MCP server entry point.
 *
 * Runs over stdio, which is what an agent host launches. Two consequences
 * shape this file:
 *
 * - **stdout is the protocol.** Nothing may write to it but JSON-RPC frames, so
 *   logging goes to stderr and Node's SQLite experimental warning is silenced.
 * - **read-only by default.** An agent given a corpus to consult should not be
 *   able to rewrite it because a document told it to; `--allow-write` is an
 *   operator decision, not an agent one.
 */

import process from "node:process";
import { parseArgs } from "node:util";

/**
 * Silence Node's `node:sqlite` experimental warning.
 *
 * It goes to stderr rather than stdout so it would not corrupt the protocol,
 * but it appears in every host's error log on every launch and reads like a
 * fault. Only this one warning is suppressed.
 */
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && text.includes("SQLite")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

import { ExitCode, createStderrLogger } from "@graphdog/core";

import { VERSION } from "./version.ts";
import { startStdioServer } from "./infrastructure/stdio-server.ts";

const USAGE = `graphdog-mcp ${VERSION} -- MCP server over a local GraphDog corpus

Usage: graphdog-mcp [options]

Options:
  -c, --corpus <name>   Corpus to serve when a tool call omits one
  -C, --cwd <path>      Directory to resolve corpora from (default: current)
      --allow-write     Expose build_corpus; off by default so an agent cannot
                        rewrite the corpus it is consulting
  -q, --quiet           Only log errors to stderr
  -v, --verbose         Log debug detail to stderr
  -h, --help            Show this message
  -V, --version         Print the version

Example (Claude Desktop / any MCP host):
  {
    "mcpServers": {
      "graphdog": {
        "command": "npx",
        "args": ["-y", "@graphdog/mcp", "--cwd", "/path/to/project"]
      }
    }
  }
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        corpus: { type: "string", short: "c" },
        cwd: { type: "string", short: "C" },
        "allow-write": { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`graphdog-mcp: ${String(error)}\n\n${USAGE}`);
    return ExitCode.USAGE;
  }

  if (values.help === true) {
    process.stdout.write(USAGE);
    return ExitCode.OK;
  }
  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return ExitCode.OK;
  }

  const logger = createStderrLogger(
    values.verbose === true ? "debug" : values.quiet === true ? "error" : "info",
  );

  try {
    await startStdioServer({
      cwd: values.cwd ?? process.cwd(),
      logger,
      defaultCorpus: values.corpus,
      allowWrite: values["allow-write"] === true,
    });
    // Resolves only when the transport closes; the process stays alive serving
    // requests until the host disconnects.
    await new Promise<void>((resolve) => {
      process.stdin.once("close", resolve);
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    return ExitCode.OK;
  } catch (error) {
    logger.log("error", "server failed to start", { error: String(error) });
    return ExitCode.ERROR;
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(baseName(process.argv[1]))) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`graphdog-mcp: unexpected failure: ${String(error)}\n`);
      process.exitCode = ExitCode.ERROR;
    });
}

function baseName(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? path : path.slice(separator + 1);
}
