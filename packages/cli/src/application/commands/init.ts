/**
 * `graphdog init` -- create a corpus in the project workspace.
 *
 * Creating `.graphdog/` in the project rather than a home directory is what
 * lets the corpus config live beside the documents it indexes and be reviewed
 * like any other file.
 */

import { resolve } from "node:path";

import {
  ConflictError,
  corpusConfigPath,
  corpusStorePath,
  defaultCorpusConfig,
  initProjectWorkspace,
  listCorpusNames,
  normalizeSourceSpec,
  saveCorpusConfig,
  type CorpusConfig,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import { optionBoolean, optionList, optionString, type CommandSpec } from "../../infrastructure/argv.ts";

export const initSpec: CommandSpec = {
  name: "init",
  summary: "Create a corpus in this project",
  usage: "graphdog init [<name>] [--source <path>] [--force]",
  options: {
    source: {
      type: "string",
      short: "s",
      multiple: true,
      description: "Directory or git repo to index (repeatable)",
      placeholder: "<path>",
    },
    description: { type: "string", description: "One line describing this corpus", placeholder: "<text>" },
    semantic: {
      type: "boolean",
      description: "Use a local semantic embedding model instead of the built-in lexical one",
    },
    force: { type: "boolean", description: "Overwrite an existing corpus config" },
  },
  examples: [
    "graphdog init docs --source ./docs",
    "graphdog init repo --source . --semantic",
  ],
};

export async function runInit(context: CommandContext): Promise<CommandResult> {
  const name = context.parsed.positionals[0] ?? "default";
  const workspace = await initProjectWorkspace(context.cwd);

  const existing = await listCorpusNames(workspace);
  if (existing.includes(name) && !optionBoolean(context.parsed, "force")) {
    throw new ConflictError(`corpus "${name}" already exists in this project`, {
      config: corpusConfigPath(workspace, name),
      remedy: "pass --force to overwrite, or choose another name",
    });
  }

  const sourcePaths = optionList(context.parsed, "source");
  const config: CorpusConfig = {
    ...defaultCorpusConfig(name),
    description: optionString(context.parsed, "description") ?? "",
    sources: sourcePaths.map((path, index) => {
      // Stored relative to the project so the config stays portable between
      // machines and checkouts.
      const absolute = resolve(context.cwd, path);
      return normalizeSourceSpec({
        id: sourceIdFor(absolute, index, sourcePaths.length),
        kind: "local",
        uri: path,
      });
    }),
    ...(optionBoolean(context.parsed, "semantic")
      ? { embedding: { provider: "transformers" as const, model: null, dimensions: 0, batchSize: 32 } }
      : {}),
  };

  await saveCorpusConfig(corpusConfigPath(workspace, name), config);

  const nextSteps =
    config.sources.length === 0
      ? ["graphdog add <path>", "graphdog build"]
      : ["graphdog build"];

  return {
    json: {
      kind: "init_result",
      corpus: name,
      config_path: corpusConfigPath(workspace, name),
      store_path: corpusStorePath(workspace, name),
      sources: config.sources.map((source) => ({ id: source.id, uri: source.uri })),
      next_steps: nextSteps,
    },
    human:
      `Created corpus "${name}" at ${corpusConfigPath(workspace, name)}\n` +
      (config.sources.length === 0
        ? "\nNo sources yet. Add one:\n  graphdog add ./docs\n"
        : `\nSources:\n${config.sources.map((s) => `  ${s.id}  ${s.uri}`).join("\n")}\n`) +
      `\nThen:\n${nextSteps.map((step) => `  ${step}`).join("\n")}\n`,
  };
}

/**
 * Derive a source id from its path.
 *
 * The id becomes the first segment of every ref, so it should read like the
 * thing it names. A single source is just `src` unless the folder has a useful
 * name, which keeps short refs short.
 */
function sourceIdFor(absolutePath: string, index: number, total: number): string {
  const base = absolutePath.split(/[\\/]/).filter(Boolean).pop() ?? "src";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "-");
  if (cleaned === "" || cleaned === ".") return total === 1 ? "src" : `src${index + 1}`;
  return cleaned;
}
