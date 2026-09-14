/**
 * Reading and validating an evaluation dataset.
 *
 * A dataset is a plain JSON file of queries with relevance judgments. It is
 * meant to be written and reviewed by hand, and to live in the repository
 * beside the documents it judges, so the format stays small and the errors say
 * exactly which entry is wrong.
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "name": "auth-docs",
 *   "corpus": "docs",
 *   "queries": [
 *     {
 *       "id": "jwks-rotation",
 *       "query": "how are signing keys rotated",
 *       "relevant": [
 *         { "ref": "docs/keys.md", "grade": 3, "lines": "12-28" },
 *         { "ref": "docs/token.md" }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * Validation is strict. A dataset is the yardstick every later measurement is
 * compared against, so a typo'd ref that silently scores as a miss would make
 * the whole number wrong in a direction nobody would question.
 */

import { readFile } from "node:fs/promises";

import { ConfigError } from "../../domain/errors.ts";
import type { Judgment } from "../../domain/service/metrics.ts";

/** Bumped when the dataset file's shape changes incompatibly. */
export const DATASET_VERSION = 1;

/** Relevance when a judgment does not state one: relevant, unweighted. */
export const DEFAULT_GRADE = 1;

export interface EvalQuery {
  readonly id: string;
  readonly query: string;
  readonly judgments: readonly Judgment[];
  /** Free-text note explaining the query's intent; carried into the report. */
  readonly note: string | null;
}

export interface EvalDataset {
  readonly name: string;
  /** Corpus this dataset judges; the CLI uses it when none is named. */
  readonly corpus: string | null;
  readonly description: string;
  readonly queries: readonly EvalQuery[];
}

export async function loadEvalDataset(path: string): Promise<EvalDataset> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`evaluation dataset not found: ${path}`, { cause: String(error) });
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`invalid JSON in ${path}: ${String(error)}`, { path });
  }
  return parseEvalDataset(data, path);
}

export function parseEvalDataset(input: unknown, path = "<dataset>"): EvalDataset {
  const data = asObject(input, path);

  const version = asNumber(data["version"], DATASET_VERSION, `${path}.version`);
  if (version > DATASET_VERSION) {
    throw new ConfigError(
      `dataset version ${version} is newer than this GraphDog understands (${DATASET_VERSION})`,
      { path },
    );
  }

  const rawQueries = data["queries"];
  if (!Array.isArray(rawQueries)) {
    throw new ConfigError(`${path}.queries must be an array`, { path });
  }
  if (rawQueries.length === 0) {
    throw new ConfigError(`${path}.queries is empty; a dataset must judge something`, { path });
  }

  const queries: EvalQuery[] = [];
  const seenIds = new Set<string>();

  rawQueries.forEach((entry, index) => {
    const where = `${path}.queries[${index}]`;
    const query = asObject(entry, where);

    const text = asString(query["query"], "", `${where}.query`);
    if (text.trim() === "") throw new ConfigError(`${where}.query must not be empty`, { path });

    // Defaults to the index so a small dataset need not name every query, but a
    // duplicate id is refused: ids are how a regression report points at the
    // query that got worse.
    const id = asString(query["id"], `q${index + 1}`, `${where}.id`);
    if (seenIds.has(id)) throw new ConfigError(`${where}.id "${id}" is not unique`, { path });
    seenIds.add(id);

    queries.push({
      id,
      query: text,
      judgments: parseJudgments(query["relevant"], `${where}.relevant`, path),
      note: query["note"] === undefined ? null : asString(query["note"], "", `${where}.note`),
    });
  });

  return {
    name: asString(data["name"], "dataset", `${path}.name`),
    corpus: data["corpus"] === undefined ? null : asString(data["corpus"], "", `${path}.corpus`),
    description: asString(data["description"], "", `${path}.description`),
    queries,
  };
}

function parseJudgments(input: unknown, where: string, path: string): Judgment[] {
  if (input === undefined) {
    // A query with no judgments is legal and useful: it measures nothing but
    // still exercises the pipeline and contributes latency. The metrics report
    // it as unmeasurable rather than as a miss.
    return [];
  }
  if (!Array.isArray(input)) {
    throw new ConfigError(`${where} must be an array`, { path });
  }

  return input.map((entry, index) => {
    const at = `${where}[${index}]`;
    // A bare string is the common case: "this document is relevant".
    if (typeof entry === "string") return { ref: entry, grade: DEFAULT_GRADE };

    const judgment = asObject(entry, at);
    const ref = asString(judgment["ref"], "", `${at}.ref`);
    if (ref.trim() === "") throw new ConfigError(`${at}.ref must not be empty`, { path });

    const grade = asNumber(judgment["grade"], DEFAULT_GRADE, `${at}.grade`);
    if (grade < 0 || grade > 3 || !Number.isInteger(grade)) {
      throw new ConfigError(`${at}.grade must be an integer from 0 to 3, got ${grade}`, { path });
    }

    const lines = parseLineRange(judgment["lines"], `${at}.lines`, path);
    return { ref, grade, ...lines };
  });
}

/** Parse `"12-28"`, `"12"`, or `[12, 28]` into an expected evidence span. */
function parseLineRange(
  input: unknown,
  where: string,
  path: string,
): { startLine?: number; endLine?: number } {
  if (input === undefined || input === null) return {};

  if (Array.isArray(input)) {
    if (input.length !== 2 || input.some((value) => !Number.isInteger(value))) {
      throw new ConfigError(`${where} as an array must be [startLine, endLine]`, { path });
    }
    return orderedRange(Number(input[0]), Number(input[1]), where, path);
  }

  if (typeof input === "number") {
    return orderedRange(input, input, where, path);
  }

  if (typeof input === "string") {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(input);
    if (match === null) {
      throw new ConfigError(`${where} must look like "12-28" or "12", got ${JSON.stringify(input)}`, {
        path,
      });
    }
    const start = Number(match[1]);
    return orderedRange(start, match[2] === undefined ? start : Number(match[2]), where, path);
  }

  throw new ConfigError(`${where} must be a string, a number or a [start, end] pair`, { path });
}

function orderedRange(
  start: number,
  end: number,
  where: string,
  path: string,
): { startLine: number; endLine: number } {
  if (start < 1 || end < 1) {
    throw new ConfigError(`${where} lines are 1-based; got ${start}-${end}`, { path });
  }
  if (end < start) {
    throw new ConfigError(`${where} ends before it starts: ${start}-${end}`, { path });
  }
  return { startLine: start, endLine: end };
}

// --- typed accessors ---------------------------------------------------------

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`, { got: typeof value });
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback: string, path: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new ConfigError(`${path} must be a string`, { got: typeof value });
  return value;
}

function asNumber(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a finite number`, { got: value });
  }
  return value;
}
