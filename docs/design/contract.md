# The contract

Everything an agent parses is defined in
`packages/core/src/application/dto/contracts.ts` and produced by the mappers
beside it. The CLI's `--json` output and the MCP server's `structuredContent`
are the same objects from the same code path.

Field names are `snake_case`: these are JSON documents read by other tools, not
JavaScript values. Key order and numeric rounding are part of the contract and
are pinned by tests, so two runs diff cleanly.

## Versioning

Every response carries three things a consumer can gate on before parsing:

```json
{
  "schema_version": "1",
  "contract_version": "1.0",
  "kind": "search"
}
```

- `schema_version` — the corpus store layout. Changing it requires a rebuild.
- `contract_version` — the shape of these documents. Additive changes bump the
  minor; a breaking change bumps the major.
- `kind` — which document this is. Switch on it, not on field presence.

## `search`

```json
{
  "schema_version": "1",
  "contract_version": "1.0",
  "kind": "search",
  "query": "JWT rotation",
  "corpus": "docs",
  "freshness": {
    "status": "current",
    "built_at": "2026-09-14T15:15:13.017Z",
    "source_revisions": { "docs": "a1b2c3d4" },
    "reason": null
  },
  "hits": [
    {
      "ref": "docs/design/token.md",
      "chunk_id": "9f2c1a...",
      "title": "アクセストークン設計",
      "heading_path": "アクセストークン設計 > ローテーション",
      "snippet": "トークンの有効期限は 1 時間とし…",
      "location": { "start_line": 10, "end_line": 13, "start_char": 214, "end_char": 388 },
      "scores": { "dense": 1.0, "bm25": 1.0, "graph": 0.0, "rerank": null, "final": 1.0 },
      "found_by": "dense",
      "graph_path": [],
      "source_revision": "a1b2c3d4",
      "tags": ["auth", "jwt"],
      "read_ref": "docs/design/token.md#L10-L13"
    }
  ],
  "suggested_queries": ["auth", "jwt", "ローテーション"],
  "strategy": {
    "fusion": "rrf",
    "dense": "hash-v1:d256",
    "lexical": "bm25",
    "graph": "expansion:2hop",
    "rerank": "off",
    "min_score": 0.12,
    "min_dense_similarity": 0.35,
    "top_k": 10
  },
  "stats": {
    "dense_candidates": 1,
    "lexical_candidates": 1,
    "graph_candidates": 2,
    "fused_candidates": 3,
    "returned": 1,
    "corpus_chunks": 4,
    "corpus_documents": 3,
    "elapsed_ms": 5
  },
  "warnings": []
}
```

### Reading a hit

**`read_ref` is the important field.** Pass it straight back to `read` and you
get those exact lines. Everything else is context for deciding whether to.

**`scores` distinguishes three states**, and the distinction is deliberate:

- a number — that signal ran and scored this chunk
- `0` — that signal ran and did not match
- `null` — that signal did not run at all

So `"bm25": 0` means "no keyword matched", while `"bm25": null` means "lexical
search was disabled". Values are min-max normalized within the result set;
`final` is the fused score, scaled so the best hit is `1.0`.

**`found_by`** names the signal most responsible: `dense`, `bm25`, `graph`, or
`none`. A hit with `found_by: "graph"` was reached by relationship rather than
by matching the query — `graph_path` then shows the chain:

```json
"graph_path": [
  { "src": "doc:docs/keys.md", "dst": "doc:docs/token.md",
    "kind": "links_to", "weight": 1.0, "relation": "links to" }
]
```

`relation` is the human phrasing, so output needs no lookup table.

**`location.page`** is present only for paginated sources (PDF, slides,
spreadsheets). Its presence is the signal that line numbers are page-relative.

### Freshness

`status` is `current`, `stale` or `unknown`.

`unknown` is not a failure — it means the corpus cannot *prove* it is current,
which is the honest answer for a plain folder with no revision concept. Claiming
freshness that cannot be verified would be worse.

Staleness never blocks a search. It attaches a `stale_corpus` warning and lets
the caller weigh it.

### `strategy` and `stats`

`strategy` records exactly how the result was produced — enough to reproduce or
explain it. `stats` reports candidate counts at each stage, which is what makes
a recall problem diagnosable without a debug rerun.

## `explore`

Everything `search` returns, plus:

```json
{
  "kind": "explore",
  "nodes": [
    { "id": "doc:docs/keys.md", "kind": "document", "label": "鍵管理", "ref": "docs/keys.md" },
    { "id": "tag:auth", "kind": "tag", "label": "auth", "ref": null }
  ],
  "edges": [
    { "src": "doc:docs/keys.md", "dst": "tag:auth",
      "kind": "same_tag", "weight": 0.5, "relation": "shares a tag with" }
  ]
}
```

Node ids are namespaced: `doc:`, `tag:`, `dir:`. Tag and directory nodes are
waypoints that connect documents; they are never returned as hits.

## `read`

```json
{
  "kind": "read",
  "corpus": "docs",
  "ref": "docs/design/token.md",
  "title": "アクセストークン設計",
  "text": "## ローテーション\n\nトークンの有効期限は…",
  "location": { "start_line": 10, "end_line": 13, "start_char": 214, "end_char": 388 },
  "total_lines": 13,
  "truncated": false,
  "source_revision": "a1b2c3d4",
  "warnings": []
}
```

`text` is verbatim. `truncated` is `true` only when output hit a character
limit, and a warning always accompanies it — text is never silently shortened.

`total_lines` is the document's real length even when a range was returned, so a
caller can tell how much it has not seen.

Accepted refs: `docs/a.md`, `docs/a.md#L10-L24`, `docs/a.md#L7`,
`docs/a.pdf#p3L4-L9`. A non-range anchor (`docs/a.md#section`) identifies the
document and returns all of it.

## `corpus_info` (`status`)

```json
{
  "kind": "corpus_info",
  "name": "docs",
  "path": "/project/.graphdog/corpora/docs/corpus.sqlite3",
  "scope": "project",
  "corpus_schema_version": "1",
  "embedding": { "id": "hash-v1:d256", "provider": "hash", "model": null,
                 "dimensions": 256, "semantic": false },
  "chunking": { "fingerprint": "chunk1:1a2b…", "expected_fingerprint": "chunk1:1a2b…" },
  "counts": { "documents": 3, "chunks": 4, "vectors": 4, "nodes": 5,
              "edges": 10, "failures": 0, "exclusions": 1 },
  "freshness": { "status": "current", "built_at": "…", "source_revisions": {}, "reason": null },
  "sources": [ { "id": "docs", "kind": "local", "uri": "/project/docs",
                 "revision": null, "document_count": 3 } ],
  "compatible": true,
  "incompatibility": null,
  "warnings": []
}
```

`compatible: false` with a populated `incompatibility` is the answer to "why
does search refuse to run". It is reported as a field, not thrown, because
describing an unusable corpus is exactly what `status` is for.

## `build_report`

```json
{
  "kind": "build_report",
  "corpus": "docs",
  "status": "partial",
  "documents": { "added": 2, "modified": 0, "deleted": 0, "unchanged": 0 },
  "chunks": 4,
  "nodes": 5,
  "edges": 10,
  "failures": [
    { "ref": "docs/scan.pdf", "stage": "extract", "code": "extraction_failed",
      "message": "PDF support requires pdfjs-dist: npm install pdfjs-dist",
      "at": "2026-09-14T15:15:13.017Z" }
  ],
  "exclusions": [
    { "ref": "docs/.env", "reason": "secret_pattern", "details": { "path": ".env" } }
  ],
  "elapsed_seconds": 0.021,
  "warnings": []
}
```

The counts reconcile: `added + modified + unchanged + failures.length` equals
the number of files discovered. A file that failed extraction is counted as a
failure and **not** as an indexed document.

`status` is `partial` whenever `failures` is non-empty, and the process exits
with code 5. A build that silently indexed 90% of a corpus is worse than one
that says so.

`exclusions` is the audit trail: every file deliberately skipped, with the
reason. `"why is this not in my results"` always has an answer.

## Errors

Failures return the same envelope on every interface — on stderr for the CLI,
as `structuredContent` with `isError: true` for MCP:

```json
{
  "error": {
    "code": "incompatible_corpus",
    "message": "corpus was indexed with embedding hash-v1:d256 but the current configuration uses st:…",
    "details": { "field": "embeddingId", "remedy": "graphdog build --full" }
  }
}
```

| Code | Exit | Meaning |
|---|---|---|
| `usage` | 2 | Bad arguments |
| `config_invalid` | 2 | Unusable configuration |
| `not_found` / `corpus_not_found` / `ref_not_found` | 3 | Does not exist |
| `incompatible_corpus` | 4 | Identity mismatch; rebuild required |
| `conflict` | 6 | Target already exists |
| `extraction_failed` | — | Per-file; collected into `failures` |
| `error` | 1 | Unexpected |

`details` carries `hint`, `remedy` and `available` where they apply — enough to
recover without reading the docs.

## Warnings

Non-fatal, never swallowed, always in a `warnings` array:

| Code | Meaning |
|---|---|
| `stale_corpus` | Behind its sources; results may be outdated |
| `no_sufficient_evidence` | Query ran, nothing cleared the threshold (exit 7) |
| `partial_index` | Some files failed; results may be incomplete |
| `range_clamped` | The requested range was clamped, or output truncated |
| `rerank_unavailable` | Reranking was asked for but could not run |
| `lexical_embedding` | Corpus uses the built-in lexical embedder |
| `extraction_note` | A file extracted with caveats, e.g. a PDF page with no text layer |
| `corpus_unreadable` | A corpus was skipped while listing |

## Stability

- Additions are always allowed. Field removals and semantic changes bump
  `contract_version`.
- Error codes, warning codes and exit codes are append-only.
- `kind` values are stable.
- Numbers round to six decimal places.

An unknown warning code or an extra field should be ignored, not rejected.
