/**
 * `graphdog add` -- register a source with an existing corpus.
 *
 * Only edits the config; indexing is `build`. Keeping the two separate means
 * adding a source is instant and reversible, and a slow build is never a
 * surprise side effect of an edit.
 */

import { basename, relative, resolve } from "node:path";

import {
  ConflictError,
  normalizeSourceSpec,
  readCorpusConfig,
  resolveCorpus,
  writeCorpusConfig,
  UsageError,
  type SourceSpec,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import { optionBoolean, optionList, optionSingleCorpus, optionString, type CommandSpec } from "../../infrastructure/argv.ts";

export const addSpec: CommandSpec = {
  name: "add",
  summary: "Register a directory or git repository as a source",
  usage: "graphdog add <path> [--id <name>] [--git] [--include <glob>] [--exclude <glob>]",
  options: {
    id: { type: "string", description: "Source id; becomes the first segment of every ref", placeholder: "<name>" },
    git: { type: "boolean", description: "Treat the path as a git working tree (records revisions, honours .gitignore)" },
    include: { type: "string", multiple: true, description: "Only index files matching this glob (repeatable)", placeholder: "<glob>" },
    exclude: { type: "string", multiple: true, description: "Skip files matching this glob (repeatable)", placeholder: "<glob>" },
    "index-secrets": { type: "boolean", description: "Index files that match secret patterns (off by default)" },
    "follow-symlinks": { type: "boolean", description: "Follow symbolic links while walking" },
  },
  examples: [
    "graphdog add ./docs",
    "graphdog add . --git --include '**/*.md'",
  ],
};

export async function runAdd(context: CommandContext): Promise<CommandResult> {
  const path = context.parsed.positionals[0];
  if (path === undefined) {
    throw new UsageError("add: a path is required", { usage: addSpec.usage });
  }

  const resolved = await resolveCorpus(optionSingleCorpus(context.parsed, "add"), context.cwd);
  const config = await readCorpusConfig(resolved);

  const absolute = resolve(context.cwd, path);
  const projectRoot = resolve(resolved.workspace.root, "..");

  // The same directory registered twice would index every file twice under two
  // different refs, so every search would return duplicate evidence. The id can
  // be auto-disambiguated; the path cannot.
  const duplicate = config.sources.find(
    (source) => resolve(projectRoot, source.uri) === absolute,
  );
  if (duplicate !== undefined) {
    throw new ConflictError(
      `that path is already registered as source "${duplicate.id}"`,
      {
        existing: duplicate.id,
        uri: duplicate.uri,
        remedy: "use a different path, or edit the existing source in graphdog.json",
      },
    );
  }

  const id = optionString(context.parsed, "id") ?? deriveId(absolute, config.sources);
  if (config.sources.some((source) => source.id === id)) {
    throw new ConflictError(`source id "${id}" is already registered`, {
      remedy: "pass --id to choose a different one",
      existing: config.sources.map((source) => source.id),
    });
  }

  // Stored relative to the project directory when it is inside it, so the
  // config still works after a clone to a different path.
  const withinProject = relative(projectRoot, absolute);
  const uri = withinProject.startsWith("..") ? absolute : `./${withinProject.split("\\").join("/")}`;

  const spec: SourceSpec = normalizeSourceSpec({
    id,
    kind: optionBoolean(context.parsed, "git") ? "git" : "local",
    uri,
    include: optionList(context.parsed, "include"),
    exclude: optionList(context.parsed, "exclude"),
    followSymlinks: optionBoolean(context.parsed, "follow-symlinks"),
    indexSecrets: optionBoolean(context.parsed, "index-secrets"),
  });

  await writeCorpusConfig(resolved, { ...config, sources: [...config.sources, spec] });

  return {
    json: {
      kind: "add_result",
      corpus: resolved.name,
      source: { id: spec.id, kind: spec.kind, uri: spec.uri },
      next_steps: ["graphdog build"],
    },
    human:
      `Added source "${spec.id}" (${spec.kind}) -> ${spec.uri}\n` +
      `\nNext:\n  graphdog build\n`,
  };
}

/** Derive a source id from the folder name, disambiguating on collision. */
function deriveId(absolutePath: string, existing: readonly SourceSpec[]): string {
  const base = basename(absolutePath).replace(/[^A-Za-z0-9._-]/g, "-");
  const candidate = base === "" || base === "." ? "src" : base;
  if (!existing.some((source) => source.id === candidate)) return candidate;
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}${suffix}`;
    if (!existing.some((source) => source.id === next)) return next;
  }
}
