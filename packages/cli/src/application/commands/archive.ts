/**
 * `graphdog export` and `graphdog import`.
 *
 * Export packages a built corpus as one `.gdog` file; import verifies one and
 * installs the corpus inside it. Neither is offered over MCP: both write files
 * at paths the caller chooses, which is not something an agent consulting a
 * corpus should be able to do as a side effect of what it read.
 */

import {
  UsageError,
  exportCorpusArchive,
  importCorpusArchive,
  toArchiveReportDto,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import {
  optionBoolean,
  optionCorpora,
  optionSingleCorpus,
  optionString,
  type CommandSpec,
} from "../../infrastructure/argv.ts";
import { renderArchiveReport } from "../../infrastructure/render/human-renderer.ts";

export const exportSpec: CommandSpec = {
  name: "export",
  summary: "Package a built corpus as one verifiable .gdog file",
  usage: "graphdog export [--corpus <name>] [--out <path>] [--force] [--json]",
  options: {
    out: {
      type: "string",
      short: "o",
      description: "Where to write the archive (default: <corpus>.gdog here)",
      placeholder: "<path>",
    },
    force: { type: "boolean", description: "Overwrite an existing file at --out" },
  },
  examples: ["graphdog export", "graphdog export --corpus docs --out dist/docs.gdog"],
};

export const importSpec: CommandSpec = {
  name: "import",
  summary: "Verify a .gdog archive and install the corpus inside it",
  usage: "graphdog import <archive.gdog> [--as <name>] [--project] [--replace] [--json]",
  options: {
    as: {
      type: "string",
      description: "Install under this name instead of the archive's own",
      placeholder: "<name>",
    },
    project: {
      type: "boolean",
      description: "Install into this project's .graphdog instead of the home workspace",
    },
    replace: { type: "boolean", description: "Replace an existing corpus of the same name" },
  },
  examples: [
    "graphdog import docs.gdog",
    "graphdog import handbook.gdog --as handbook --project",
  ],
};

export async function runExport(context: CommandContext): Promise<CommandResult> {
  if (context.parsed.positionals.length > 0) {
    throw new UsageError("export: takes no positional arguments; use --out to choose the file", {
      usage: exportSpec.usage,
      received: context.parsed.positionals,
    });
  }

  const corpus = optionSingleCorpus(context.parsed, "export");
  const out = optionString(context.parsed, "out");
  const outcome = await exportCorpusArchive({
    ...(corpus === undefined ? {} : { corpus }),
    ...(out === undefined ? {} : { out }),
    overwrite: optionBoolean(context.parsed, "force"),
    cwd: context.cwd,
    logger: context.logger,
  });

  const report = toArchiveReportDto(outcome);
  return { json: report, human: renderArchiveReport(report) };
}

export async function runImport(context: CommandContext): Promise<CommandResult> {
  const [archive, ...extra] = context.parsed.positionals;
  if (archive === undefined) {
    throw new UsageError("import: an archive path is required", { usage: importSpec.usage });
  }
  if (extra.length > 0) {
    throw new UsageError("import: takes one archive at a time", {
      usage: importSpec.usage,
      received: context.parsed.positionals,
    });
  }
  // `--corpus` names an existing corpus everywhere else. Accepting it here as
  // "the name to install under" would make one flag mean two opposite things.
  if (optionCorpora(context.parsed).length > 0) {
    throw new UsageError("import: use --as to choose the name to install under; --corpus names an existing corpus", {
      usage: importSpec.usage,
    });
  }

  const name = optionString(context.parsed, "as");
  const outcome = await importCorpusArchive({
    archivePath: archive,
    ...(name === undefined ? {} : { name }),
    replace: optionBoolean(context.parsed, "replace"),
    scope: optionBoolean(context.parsed, "project") ? "project" : "home",
    cwd: context.cwd,
    logger: context.logger,
  });

  const report = toArchiveReportDto(outcome);
  return { json: report, human: renderArchiveReport(report) };
}
