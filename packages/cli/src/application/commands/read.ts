/**
 * `graphdog read` -- fetch the verbatim text behind a citation.
 *
 * This is what closes the loop: every hit carries a `read_ref` that can be
 * passed straight back here, so an agent can verify evidence rather than trust
 * a snippet.
 */

import {
  UsageError,
  openCorpus,
  readDocument,
  toLocationDto,
  toWarningDtos,
  type ReadResponseDto,
} from "@graphdog/core";

import type { CommandContext, CommandResult } from "./types.ts";
import { optionNumber, optionString, type CommandSpec } from "../../infrastructure/argv.ts";
import { renderRead } from "../../infrastructure/render/human-renderer.ts";

export const readSpec: CommandSpec = {
  name: "read",
  summary: "Print the exact source text behind a ref",
  usage: "graphdog read <ref>[#L10-L24] [--lines <a-b>] [--max-chars <n>]",
  options: {
    lines: { type: "string", short: "l", description: "Line range to return, e.g. 10-24", placeholder: "<a-b>" },
    "max-chars": { type: "string", description: "Truncate the output at this many characters", placeholder: "<n>" },
  },
  examples: [
    "graphdog read docs/design/token.md",
    "graphdog read 'docs/design/token.md#L10-L24'",
  ],
};

export async function runRead(context: CommandContext): Promise<CommandResult> {
  const ref = context.parsed.positionals[0];
  if (ref === undefined || ref === "") {
    throw new UsageError("read: a ref is required", {
      usage: readSpec.usage,
      hint: "copy the read_ref field from any search result",
    });
  }

  const range = parseLineRange(optionString(context.parsed, "lines"));
  const name = optionString(context.parsed, "corpus");
  const corpus = await openCorpus({
    ...(name === undefined ? {} : { corpus: name }),
    cwd: context.cwd,
    logger: context.logger,
    withoutSources: true,
  });

  try {
    const outcome = readDocument(
      {
        ref,
        ...range,
        ...(optionNumber(context.parsed, "max-chars", "read") === undefined
          ? {}
          : { maxChars: optionNumber(context.parsed, "max-chars", "read") as number }),
      },
      { store: corpus.store, corpusName: corpus.name },
    );

    const response: ReadResponseDto = {
      schema_version: "1",
      contract_version: "1.0",
      kind: "read",
      corpus: outcome.corpus,
      ref: outcome.ref,
      title: outcome.title,
      text: outcome.text,
      location: toLocationDto(outcome.location),
      total_lines: outcome.totalLines,
      truncated: outcome.truncated,
      source_revision: outcome.sourceRevision,
      warnings: toWarningDtos(outcome.warnings),
    };

    return { json: response, human: renderRead(response) };
  } finally {
    corpus.close();
  }
}

/** Parse `--lines 10-24`, `--lines 10-`, or `--lines 10`. */
function parseLineRange(input: string | undefined): { startLine?: number; endLine?: number } {
  if (input === undefined || input === "") return {};
  const match = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(input.trim());
  if (match === null) {
    throw new UsageError(`read: --lines must look like 10-24, got ${JSON.stringify(input)}`);
  }
  const start = Number(match[1]);
  const end = match[2] === undefined ? undefined : Number(match[2]);
  return {
    startLine: start,
    // An open-ended range reads to the end of the document; readDocument clamps.
    endLine: end ?? (match[0].includes("-") ? Number.MAX_SAFE_INTEGER : start),
  };
}
