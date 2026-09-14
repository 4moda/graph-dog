/**
 * The MCP tool surface.
 *
 * Definitions are separate from execution so the schema, the description and
 * the permission level of a tool are all visible in one place -- which is what
 * an agent actually reads before deciding to call it.
 *
 * Descriptions are written for the caller, not the implementer. An agent choosing
 * between `search` and `explore` needs to know what each *returns*, and `read`
 * needs to say that it takes the `read_ref` the other two hand back; without
 * that, the obvious failure mode is an agent that searches and then guesses.
 */

export type ToolPermission = "read" | "write";

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** `write` tools mutate a corpus and are refused unless explicitly enabled. */
  readonly permission: ToolPermission;
  /** Hint for clients: a read-only tool is safe to call speculatively. */
  readonly readOnly: boolean;
}

const corpusProperty = {
  corpus: {
    type: "string",
    description:
      "Corpus name. Omit when only one corpus exists; call list_corpora to see the options.",
  },
} as const;

/** Search and explore additionally accept several corpora at once. */
const multiCorpusProperties = {
  ...corpusProperty,
  corpora: {
    type: "array",
    items: { type: "string" },
    description:
      "Search these corpora together. Results are merged by rank; each hit reports which " +
      "corpus it came from. Overrides `corpus` when both are given.",
  },
  all_corpora: {
    type: "boolean",
    description: "Search every corpus visible to the server. Overrides `corpus` and `corpora`.",
  },
} as const;

export const SEARCH_TOOL: ToolDefinition = {
  name: "search",
  title: "Search the knowledge corpus",
  description:
    "Find evidence for a question in the local document corpus. Returns ranked hits, each " +
    "with a source ref, an exact line range, a snippet, and a per-signal score breakdown " +
    "(dense vector, BM25 keyword, graph proximity). Pass a hit's read_ref to the read tool " +
    "to get the verbatim text. Returns no hits, with an explanatory warning, when nothing " +
    "clears the relevance threshold -- treat that as 'not in the corpus', not as an error. " +
    "Can search several corpora at once via `corpora` or `all_corpora`, in which case hits " +
    "are merged by rank and each reports its source corpus.",
  permission: "read",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      ...multiCorpusProperties,
      query: { type: "string", description: "What to look for, in natural language or keywords." },
      top_k: { type: "integer", description: "Maximum hits to return. Default 10.", minimum: 1, maximum: 50 },
      min_score: {
        type: "number",
        description: "Drop hits below this fused score, 0 to 1. Raise it to demand stronger evidence.",
        minimum: 0,
        maximum: 1,
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "Restrict results to these source ids.",
      },
      rerank: {
        type: "boolean",
        description:
          "Re-score the shortlist with a cross-encoder. More accurate, noticeably slower, " +
          "and only available if the corpus has a reranker configured.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const EXPLORE_TOOL: ToolDefinition = {
  name: "explore",
  title: "Explore the neighbourhood around a question",
  description:
    "Like search, but also returns the graph neighbourhood connecting the results: the " +
    "documents that link to them, share their tags, or sit beside them. Use this when the " +
    "goal is to map an area rather than answer one question, or when search returned a " +
    "single hit and you need to know what surrounds it.",
  permission: "read",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      ...multiCorpusProperties,
      query: { type: "string", description: "What to look for." },
      top_k: { type: "integer", description: "Maximum hits to return. Default 10.", minimum: 1, maximum: 50 },
      hops: {
        type: "integer",
        description: "How far to walk the graph from each result. Default 3, 0 disables it.",
        minimum: 0,
        maximum: 5,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const READ_TOOL: ToolDefinition = {
  name: "read",
  title: "Read the source text behind a ref",
  description:
    "Return the exact, unmodified text of an indexed document. Takes the read_ref field " +
    "from any search or explore hit (for example 'docs/design/token.md#L10-L24'), or a bare " +
    "ref for the whole document. This is how a citation gets verified rather than trusted: " +
    "the text returned is what is in the file. Output is truncated only with an explicit " +
    "truncated flag and a warning.",
  permission: "read",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      ...corpusProperty,
      ref: {
        type: "string",
        description: "Document ref, optionally with a line range: 'docs/a.md' or 'docs/a.md#L10-L24'.",
      },
      start_line: { type: "integer", description: "First line to return, 1-based inclusive.", minimum: 1 },
      end_line: { type: "integer", description: "Last line to return, inclusive.", minimum: 1 },
      max_chars: {
        type: "integer",
        description: "Truncate at this many characters. Default 60000.",
        minimum: 100,
      },
    },
    required: ["ref"],
    additionalProperties: false,
  },
};

export const STATUS_TOOL: ToolDefinition = {
  name: "status",
  title: "Report corpus health",
  description:
    "Describe one corpus: how many documents and chunks it holds, which embedding model " +
    "built it, whether it is still compatible with this build, how far behind its sources " +
    "it has fallen, and how many files failed to index. Call this before relying on search " +
    "results: a stale or partially built corpus still answers queries, and this is how that " +
    "becomes visible.",
  permission: "read",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { ...corpusProperty },
    additionalProperties: false,
  },
};

export const LIST_CORPORA_TOOL: ToolDefinition = {
  name: "list_corpora",
  title: "List available corpora",
  description:
    "List every corpus reachable from the server's working directory, with its document " +
    "count and whether it can currently be searched. Call this first when the corpus name " +
    "is unknown, or when a search reports that several corpora are available.",
  permission: "read",
  readOnly: true,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const BUILD_TOOL: ToolDefinition = {
  name: "build_corpus",
  title: "Build or update the corpus index",
  description:
    "Re-index the corpus from its configured sources. Only available when the server was " +
    "started with write access enabled. Returns a report of what was added, changed, " +
    "deleted and skipped, including any files that failed to index.",
  permission: "write",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      ...corpusProperty,
      full: {
        type: "boolean",
        description: "Re-index every file instead of only those whose content changed.",
      },
    },
    additionalProperties: false,
  },
};

export const READ_ONLY_TOOLS: readonly ToolDefinition[] = [
  SEARCH_TOOL,
  EXPLORE_TOOL,
  READ_TOOL,
  STATUS_TOOL,
  LIST_CORPORA_TOOL,
];

export const WRITE_TOOLS: readonly ToolDefinition[] = [BUILD_TOOL];

/**
 * The tools this server exposes.
 *
 * Search/read and build/publish are separated because an agent given a corpus
 * to consult should not be able to rewrite it as a side effect of a prompt. The
 * default is read-only and enabling writes is an explicit operator decision.
 */
export function toolsFor(allowWrite: boolean): ToolDefinition[] {
  return allowWrite ? [...READ_ONLY_TOOLS, ...WRITE_TOOLS] : [...READ_ONLY_TOOLS];
}
