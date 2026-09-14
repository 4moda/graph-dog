/**
 * Resolving a link target written in a document to a corpus ref.
 *
 * Link targets in real documents take four shapes: a path relative to the
 * linking file, a path from the source root, a bare filename, or a wiki title
 * with no extension. All four are tried, most specific first.
 *
 * An ambiguous bare name resolves to *nothing* rather than to an arbitrary
 * candidate. A wrong edge is worse than a missing one: it silently pulls
 * unrelated documents into results and there is no way for a reader to tell.
 */

import { refBasename, refDirectory } from "../model/document.ts";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function normalizeJoin(base: string, target: string): string {
  const segments: string[] = base === "" ? [] : base.split("/");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

export class LinkResolver {
  readonly #refs: ReadonlySet<string>;
  readonly #byBasename: Map<string, string[]>;
  readonly #byStem: Map<string, string[]>;

  constructor(refs: Iterable<string>) {
    this.#refs = new Set(refs);
    this.#byBasename = new Map();
    this.#byStem = new Map();
    for (const ref of this.#refs) {
      const basename = refBasename(ref).toLowerCase();
      push(this.#byBasename, basename, ref);
      push(this.#byStem, stripExtension(basename), ref);
    }
  }

  /** Resolve `target` as written in `fromRef`, or null if it is not unambiguous. */
  resolve(fromRef: string, target: string): string | null {
    const cleaned = (target.split("#")[0] ?? "").trim();
    if (cleaned === "") return null;

    const sourceId = fromRef.split("/")[0] ?? "";
    const relative = normalizeJoin(refDirectory(fromRef), cleaned);
    const fromRoot = normalizeJoin(sourceId, cleaned.replace(/^\/+/, ""));

    const candidates = [
      relative,
      ...MARKDOWN_EXTENSIONS.map((extension) => `${relative}${extension}`),
      fromRoot,
      ...MARKDOWN_EXTENSIONS.map((extension) => `${fromRoot}${extension}`),
    ];
    for (const candidate of candidates) {
      if (this.#refs.has(candidate)) return candidate;
    }

    const name = (cleaned.split("/").pop() ?? "").toLowerCase();
    for (const table of [this.#byBasename, this.#byStem]) {
      const matches = table.get(name);
      if (matches === undefined || matches.length === 0) continue;
      if (matches.length === 1) return matches[0] ?? null;
      // Ambiguous across the corpus: accept it only if exactly one candidate
      // lives in the linking document's own source.
      const sameSource = matches.filter((ref) => ref.startsWith(`${sourceId}/`));
      if (sameSource.length === 1) return sameSource[0] ?? null;
      return null;
    }
    return null;
  }
}

function push(table: Map<string, string[]>, key: string, value: string): void {
  const existing = table.get(key);
  if (existing) existing.push(value);
  else table.set(key, [value]);
}
