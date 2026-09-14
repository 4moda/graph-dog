/**
 * Command-line parsing, on top of `node:util`'s `parseArgs`.
 *
 * No argument-parsing dependency: the surface is small, and a CLI an agent runs
 * through `npx` should not pull a tree of packages to read `--json`.
 *
 * The parser is strict about unknown options. A typo'd flag that is silently
 * ignored produces a result the caller believes was filtered when it was not,
 * which is exactly the sort of quiet wrongness this tool is meant to avoid.
 */

import { parseArgs } from "node:util";

import { UsageError } from "@graphdog/core";

export interface ParsedCommand {
  readonly command: string;
  readonly positionals: string[];
  readonly options: Record<string, string | boolean | string[]>;
}

export type OptionType = "string" | "boolean";

export interface OptionSpec {
  readonly type: OptionType;
  readonly short?: string;
  readonly multiple?: boolean;
  readonly description: string;
  readonly placeholder?: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly options: Record<string, OptionSpec>;
  /** Shown under the usage line; the two or three examples worth memorizing. */
  readonly examples?: readonly string[];
}

/** Options every command accepts. */
export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  corpus: {
    type: "string",
    short: "c",
    multiple: true,
    description: "Corpus to operate on; repeatable where several are supported",
    placeholder: "<name>",
  },
  json: {
    type: "boolean",
    description: "Emit the machine-readable contract on stdout",
  },
  quiet: {
    type: "boolean",
    short: "q",
    description: "Suppress progress output on stderr",
  },
  verbose: {
    type: "boolean",
    short: "v",
    description: "Print debug progress on stderr",
  },
  help: {
    type: "boolean",
    short: "h",
    description: "Show help for this command",
  },
};

export function parseCommandLine(
  argv: readonly string[],
  spec: CommandSpec,
): ParsedCommand {
  const merged = { ...GLOBAL_OPTIONS, ...spec.options };
  const options: Record<string, { type: OptionType; short?: string; multiple?: boolean }> = {};
  for (const [name, option] of Object.entries(merged)) {
    options[name] = {
      type: option.type,
      ...(option.short === undefined ? {} : { short: option.short }),
      ...(option.multiple === undefined ? {} : { multiple: option.multiple }),
    };
  }

  try {
    const result = parseArgs({
      args: [...argv],
      options,
      allowPositionals: true,
      strict: true,
    });
    return {
      command: spec.name,
      positionals: result.positionals,
      options: result.values as Record<string, string | boolean | string[]>,
    };
  } catch (error) {
    throw new UsageError(`${spec.name}: ${messageOf(error)}`, {
      usage: spec.usage,
      hint: `run 'graphdog ${spec.name} --help' for the full option list`,
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function optionString(parsed: ParsedCommand, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}

export function optionBoolean(parsed: ParsedCommand, name: string): boolean {
  return parsed.options[name] === true;
}

export function optionList(parsed: ParsedCommand, name: string): string[] {
  const value = parsed.options[name];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

/**
 * Read a numeric option, rejecting nonsense rather than coercing it.
 *
 * `--top-k banana` silently becoming `NaN` and then `0` would return an empty
 * result set that looks like "nothing matched".
 */
export function optionNumber(
  parsed: ParsedCommand,
  name: string,
  command: string,
): number | undefined {
  const raw = optionString(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`${command}: --${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Every `--corpus` given, in order. */
export function optionCorpora(parsed: ParsedCommand): string[] {
  return optionList(parsed, "corpus");
}

/**
 * The single `--corpus` for a command that operates on one.
 *
 * Several is a usage error rather than "use the first": silently ignoring the
 * rest would report on a corpus the caller did not mean.
 */
export function optionSingleCorpus(
  parsed: ParsedCommand,
  command: string,
): string | undefined {
  const names = optionCorpora(parsed);
  if (names.length > 1) {
    throw new UsageError(`${command}: --corpus may only be given once here`, {
      received: names,
      hint: "only 'search' and 'explore' accept several corpora",
    });
  }
  return names[0];
}

/** Render `--help` for one command. */
export function renderCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [`graphdog ${spec.name} -- ${spec.summary}`, "", `Usage: ${spec.usage}`];

  const own = Object.entries(spec.options);
  if (own.length > 0) {
    lines.push("", "Options:");
    for (const [name, option] of own) lines.push(formatOption(name, option));
  }

  lines.push("", "Common options:");
  for (const [name, option] of Object.entries(GLOBAL_OPTIONS)) {
    lines.push(formatOption(name, option));
  }

  if (spec.examples !== undefined && spec.examples.length > 0) {
    lines.push("", "Examples:");
    for (const example of spec.examples) lines.push(`  ${example}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatOption(name: string, option: OptionSpec): string {
  const short = option.short === undefined ? "    " : `-${option.short}, `;
  const placeholder = option.placeholder ?? (option.type === "string" ? "<value>" : "");
  const flag = `${short}--${name}${placeholder === "" ? "" : ` ${placeholder}`}`;
  return `  ${flag.padEnd(34)}${option.description}`;
}
