/**
 * Editing an agent's JSON configuration without owning it.
 *
 * These files belong to the agent and to the user. GraphDog sets one property
 * -- its MCP server entry -- and must leave everything else alone, including
 * other tools' entries beside its own. So the file is read, one path is set or
 * deleted, and the rest is written back as it was parsed.
 *
 * What is *not* preserved is formatting: indentation, key order in objects the
 * edit touches, and any trailing whitespace come back normalized, because JSON
 * has no way to round-trip them. These are machine-written configuration files
 * and that is an acceptable trade; it would not be for a file a person writes
 * prose in, which is why those get a marker block instead.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ConfigError } from "../../domain/errors.ts";

export type JsonObject = Record<string, unknown>;

/**
 * Read a configuration, or `null` when there is no file.
 *
 * Null rather than an empty object, because "the user has no configuration
 * here" and "the user has an empty one" lead to different uninstalls: only a
 * file GraphDog brought into existence is a file GraphDog may delete.
 */
export async function readJsonConfig(path: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (text.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON, so GraphDog will not rewrite it`, {
      path,
      reason: String(error),
      remedy: "fix the file by hand, then run the command again",
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} is not a JSON object, so GraphDog will not rewrite it`, { path });
  }
  return parsed as JsonObject;
}

export async function writeJsonConfig(path: string, document: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

/** Split `a.b.c` into its segments, refusing an empty one. */
function segments(path: string): string[] {
  const parts = path.split(".");
  if (parts.length === 0 || parts.some((part) => part === "")) {
    throw new ConfigError(`invalid configuration path ${JSON.stringify(path)}`);
  }
  return parts;
}

export function getAtPath(document: JsonObject, path: string): unknown {
  let current: unknown = document;
  for (const key of segments(path)) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[key];
  }
  return current;
}

/**
 * Set one property, creating the objects above it.
 *
 * Returns a new document; the input is not modified, so a caller can compare
 * the two and decide whether anything needs writing at all.
 */
export function setAtPath(document: JsonObject, path: string, value: unknown): JsonObject {
  const [head, ...rest] = segments(path);
  if (head === undefined) return document;
  if (rest.length === 0) return { ...document, [head]: value };

  const child = document[head];
  // A non-object in the way is a real conflict: something else means something
  // different by this name, and overwriting it would be silent damage.
  if (child !== undefined && (typeof child !== "object" || child === null || Array.isArray(child))) {
    throw new ConfigError(`cannot write ${path}: ${head} is already set to something that is not an object`, {
      path,
    });
  }
  return { ...document, [head]: setAtPath((child as JsonObject | undefined) ?? {}, rest.join("."), value) };
}

/**
 * Delete one property, and any object above it that is now empty.
 *
 * Pruning is what lets `{"mcpServers": {"graphdog": …}}` come back to `{}`, so
 * the caller can see a configuration that now holds nothing and delete the file
 * -- without ever deleting one that still holds somebody else's server.
 */
export function deleteAtPath(document: JsonObject, path: string): { document: JsonObject; removed: boolean } {
  const [head, ...rest] = segments(path);
  if (head === undefined || !(head in document)) return { document, removed: false };

  if (rest.length === 0) {
    const { [head]: _gone, ...kept } = document;
    return { document: kept, removed: true };
  }

  const child = document[head];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    return { document, removed: false };
  }

  const inner = deleteAtPath(child as JsonObject, rest.join("."));
  if (!inner.removed) return { document, removed: false };
  if (Object.keys(inner.document).length === 0) {
    const { [head]: _empty, ...kept } = document;
    return { document: kept, removed: true };
  }
  return { document: { ...document, [head]: inner.document }, removed: true };
}

/** Does this document hold nothing at all? */
export function isEmptyConfig(document: JsonObject): boolean {
  return Object.keys(document).length === 0;
}
