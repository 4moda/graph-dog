/**
 * Markdown structure extraction.
 *
 * Only what the index actually needs: front matter, headings, links and tags.
 * A full CommonMark parser would be a dependency and a large behaviour surface
 * for no retrieval gain, because chunks are indexed as raw text rather than as
 * rendered HTML.
 */

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/;
const ATX_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(?:```|~~~)/;
const MD_LINK = /(?<!!)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKI_LINK = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;
/**
 * Inline `#tag`.
 *
 * Unicode property escapes rather than `\w`: JavaScript's `\w` is ASCII-only,
 * so an ASCII class would silently fail to match Japanese tags. The trailing
 * quantifier allows zero, so a single-character tag such as `#鍵` is valid.
 */
const INLINE_TAG = /(?<![\p{L}\p{N}_/#])#(\p{L}[\p{L}\p{N}_\-/]{0,48})/gu;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

/**
 * Control characters that break XML/GraphML export and confuse line counting.
 * Built from a string so the source file itself stays free of control bytes.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g");

/** Remove control characters, preserving tab, newline and carriage return. */
export function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

/** Normalize line endings so stored line numbers match what an editor shows. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export interface FrontMatter {
  readonly fields: Record<string, string | string[]>;
  /** Lines the front-matter block occupies, so line numbers stay true. */
  readonly lineOffset: number;
}

/**
 * Parse a leading YAML front-matter block.
 *
 * Only the flat `key: value`, `key: [a, b]` and `key:` + `- item` subset is
 * handled, which covers `title` and `tags` without pulling in a YAML parser.
 * Anything more exotic is ignored rather than guessed at -- a wrong guess here
 * would silently mislabel documents.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { fields: {}, lineOffset: 0 };

  const fields: Record<string, string | string[]> = {};
  let listKey: string | null = null;

  for (const raw of (match[1] ?? "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && listKey !== null) {
      const item = unquote(trimmed.slice(2).trim());
      const existing = fields[listKey];
      if (Array.isArray(existing)) existing.push(item);
      else fields[listKey] = [item];
      continue;
    }

    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;

    if (!value) {
      listKey = key;
      fields[key] = [];
      continue;
    }
    listKey = null;
    if (value.startsWith("[") && value.endsWith("]")) {
      fields[key] = value
        .slice(1, -1)
        .split(",")
        .map((entry) => unquote(entry.trim()))
        .filter((entry) => entry.length > 0);
    } else {
      fields[key] = unquote(value);
    }
  }

  const consumed = match[0] ?? "";
  return { fields, lineOffset: (consumed.match(/\n/g) ?? []).length };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1);
  }
  return value;
}

/**
 * Internal link targets, in document order, de-duplicated.
 *
 * External URLs and pure anchors are skipped: they cannot resolve to another
 * document in this corpus, so they would only add noise to the graph.
 */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const body = stripCodeFences(text);

  MD_LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MD_LINK.exec(body)) !== null) {
    const target = (match[2] ?? "").trim();
    if (!target || EXTERNAL_TARGET.test(target)) continue;
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }

  WIKI_LINK.lastIndex = 0;
  while ((match = WIKI_LINK.exec(body)) !== null) {
    const target = (match[1] ?? "").trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

/** Front-matter `tags` first, then inline `#tag` occurrences outside code fences. */
export function extractTags(
  text: string,
  frontMatter: Readonly<Record<string, string | string[]>> = {},
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const raw = frontMatter["tags"];
  const declared = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  for (const entry of declared) {
    const tag = String(entry).trim().replace(/^#/, "");
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }

  const body = stripCodeFences(stripFrontMatter(text));
  INLINE_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_TAG.exec(body)) !== null) {
    const tag = match[1] ?? "";
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function stripFrontMatter(text: string): string {
  return text.replace(FRONT_MATTER, "");
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
}

export interface HeadingEntry {
  /** 0-based index of the line carrying the heading. */
  readonly lineIndex: number;
  readonly level: number;
  readonly title: string;
}

/** ATX headings outside code fences, with their line index. */
export function headingOutline(lines: readonly string[]): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = ATX_HEADING.exec(line);
    if (match) {
      out.push({ lineIndex: i, level: (match[1] ?? "").length, title: (match[2] ?? "").trim() });
    }
  }
  return out;
}

/** First heading in a document, used as a fallback title. */
export function firstHeading(text: string): string | null {
  for (const line of stripFrontMatter(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const title = trimmed.replace(/^#+/, "").trim();
      return title || null;
    }
    if (trimmed) break;
  }
  return null;
}

/**
 * Flatten Markdown to prose, for snippet display only.
 *
 * Indexing still uses the raw text: stripping syntax before indexing would
 * make code identifiers and link targets unsearchable.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(FRONT_MATTER, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(WIKI_LINK, (_match, target: string, alias?: string) => alias ?? target)
    .replace(MD_LINK, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "$1")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
