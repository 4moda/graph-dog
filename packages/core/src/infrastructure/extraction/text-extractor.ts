/**
 * Plain-text and Markdown extraction.
 *
 * Text is normalized (line endings, control characters) but never rewritten:
 * the indexed text must stay byte-comparable with the file on disk, because
 * `read` hands those exact characters back as evidence and a line number that
 * does not match the user's editor is worse than no line number.
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { ExtractionError } from "../../domain/errors.ts";
import {
  extractLinks,
  extractTags,
  firstHeading,
  normalizeNewlines,
  parseFrontMatter,
  sanitize,
} from "../../domain/service/markdown.ts";
import type { ContentExtractor, ExtractedDocument } from "../../application/ports/sources.ts";

export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown", ".mdx"]);

/**
 * Extensions read as plain text.
 *
 * Source code is included deliberately: "where is this function documented"
 * and "where is it implemented" are the same question to an agent, and code
 * comments are often the only documentation that exists.
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".txt", ".rst", ".adoc", ".asciidoc", ".org", ".text", ".log",
  ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".rb", ".php", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".m", ".mm",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat",
  ".sql", ".graphql", ".gql", ".proto", ".tf", ".tfvars", ".hcl",
  ".html", ".htm", ".xml", ".xhtml", ".svg", ".css", ".scss", ".sass", ".less",
  ".vue", ".svelte", ".astro", ".tex", ".bib", ".dockerfile", ".gradle", ".make",
]);

export class TextExtractor implements ContentExtractor {
  readonly name = "text";
  readonly extensions: ReadonlySet<string> = new Set([
    ...MARKDOWN_EXTENSIONS,
    ...TEXT_EXTENSIONS,
  ]);

  async extract(absolutePath: string): Promise<ExtractedDocument> {
    let raw: Buffer;
    try {
      raw = await readFile(absolutePath);
    } catch (error) {
      throw new ExtractionError(`cannot read file: ${String(error)}`, { path: absolutePath });
    }

    const { text: decoded, note } = decode(raw);
    const text = sanitize(normalizeNewlines(decoded));

    const isMarkdown = MARKDOWN_EXTENSIONS.has(extname(absolutePath).toLowerCase());
    const frontMatter = isMarkdown ? parseFrontMatter(text).fields : {};

    const declaredTitle = frontMatter["title"];
    const title =
      (typeof declaredTitle === "string" ? declaredTitle.trim() : "") ||
      (isMarkdown ? (firstHeading(text) ?? "") : "") ||
      stem(absolutePath);

    return {
      text,
      title,
      mediaType: isMarkdown ? "text/markdown" : "text/plain",
      pageBreaks: [],
      // Links and tags are Markdown concepts; harvesting them from source code
      // would fill the graph with edges nobody wrote.
      tags: isMarkdown ? extractTags(text, frontMatter) : [],
      links: isMarkdown ? extractLinks(text) : [],
      notes: note === null ? [] : [note],
    };
  }
}

/**
 * Decode bytes, preferring UTF-8.
 *
 * Legacy Japanese encodings are attempted before giving up, because a corpus of
 * internal documents very often contains a few Shift-JIS files. A fallback is
 * always *reported*: silently mojibake-ing a document makes it unsearchable in
 * a way nobody can diagnose from the results.
 */
function decode(raw: Buffer): { text: string; note: string | null } {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  if (!utf8.includes("�")) {
    return { text: utf8.replace(/^﻿/, ""), note: null };
  }

  for (const encoding of ["shift_jis", "euc-jp", "windows-1252"]) {
    try {
      const decoded = new TextDecoder(encoding, { fatal: true }).decode(raw);
      return { text: decoded, note: `decoded as ${encoding}, not UTF-8` };
    } catch {
      continue;
    }
  }
  return {
    text: utf8,
    note: "file is not valid UTF-8 and no fallback encoding matched; undecodable bytes were replaced",
  };
}

function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
