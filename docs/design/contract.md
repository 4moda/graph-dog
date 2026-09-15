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
  "contract_version": "1.2",
  "kind": "search"
}
```

- `schema_version` — the corpus store layout. Changing it requires a rebuild.
- `contract_version` — the shape of these documents. Additive changes bump the
  minor; a breaking change bumps the major.
- `kind` — which document this is. Switch on it, not on field presence.

**1.1** added `corpus` and `corpus_rank` to every hit, a `corpora` array to
search and explore responses, and the `evaluation_report` kind. **1.2** emits
`archive_report` from `export` and `import`. Both additive: a 1.0 consumer reads
a 1.2 response without changes.

## `search`

```json
{
  "schema_version": "1",
  "contract_version": "1.2",
  "kind": "search",
  "query": "JWT rotation",
  "corpus": "docs",
  "corpora": [
    { "name": "docs", "scope": "project", "embedding_id": "hash-v1:d256",
      "hits": 1, "searched": true, "skipped_reason": null }
  ],
  "freshness": {
    "status": "current",
    "built_at": "2026-09-14T15:15:13.017Z",
    "source_revisions": { "docs": "a1b2c3d4" },
    "reason": null
  },
  "hits": [
    {
      "corpus": "docs",
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
      "read_ref": "docs/design/token.md#L10-L13",
      "corpus_rank": 1
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

### Searching several corpora

`--corpus` is repeatable and `--all` searches everything visible; MCP takes
`corpora` or `all_corpora`. The response shape does not change — `hits` stays a
single ranked list — but two fields carry the extra structure:

- **`corpora`** reports every corpus considered, including ones that were *not*
  searched, with `searched: false` and a `skipped_reason`. A corpus that could
  not be opened never silently disappears from the answer.
- **`corpus`** and **`corpus_rank`** on each hit say where it came from and
  where it placed *within its own corpus*, so `#1 in runbooks` stays visible
  after merging.

Results are merged **by rank, not by score**. Each corpus normalizes its own
best hit to `1.0`, so a weak corpus's best and a strong corpus's best both read
as `1.0`; interleaving those numbers would systematically promote the corpus
with the least to offer. Ranks carry no such distortion, so the merge is another
RRF pass. `strategy.fusion` reads `rrf-cross-corpus`, and `strategy.per_corpus`
holds each corpus's own strategy block.

Per-signal scores keep the calibration of the corpus they came from, so only
`final` is rewritten by the merge. Searching one corpus takes the single-corpus
path unchanged.

Corpora built with different embedding models can be searched together; the
response carries a `mixed_embeddings` warning saying so. Refusing would be
unhelpful, and pretending the scores are comparable would be dishonest — the
rank-based merge is what makes it defensible at all.

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

## `archive_report`

Produced by `graphdog export` and `graphdog import`. CLI only, like `eval`: both
write files at paths the caller chooses, which an agent consulting a corpus
should not be able to do.

```json
{
  "kind": "archive_report",
  "operation": "import",
  "corpus": "handbook",
  "archive_path": "/home/me/downloads/docs.gdog",
  "bytes": 20480,
  "checksum": "3f2a…",
  "destination": { "path": "/home/me/.graphdog/corpora/handbook", "scope": "home", "replaced": false },
  "manifest": {
    "format_version": 1,
    "corpus": "docs",
    "created_at": "2026-09-15T12:00:00.000Z",
    "created_by": "graphdog 0.1.0",
    "built_at": "2026-09-14T15:15:13.017Z",
    "identity": { "schema_version": "1", "chunking_schema_version": "1",
                  "embedding_id": "hash-v1:d256", "chunking_fingerprint": "chunk1:9a0c…" },
    "counts": { "documents": 4, "chunks": 57, "nodes": 5, "edges": 10 },
    "sources": [ { "id": "docs", "revision": null }, { "id": "spec", "revision": "a1b2c3d4" } ]
  },
  "warnings": []
}
```

`checksum` is the SHA-256 of the archive file itself, so a copy can be checked
before anyone imports it. `destination` is null for an export. `corpus` is the
name on this machine; `manifest.corpus` is the name it was built under, which
`--as` does not change.

### The archive format

A `.gdog` file is a gzip-compressed ustar archive of exactly three files, so
`tar -tzf docs.gdog` lists it:

```
manifest.json    what the archive claims: identity, counts, sources, and the
                 size and SHA-256 of each file below
graphdog.json    the corpus config, byte-for-byte as `graphdog init` writes it
corpus.sqlite3   a VACUUM INTO snapshot: consistent, compacted, one file
```

The manifest is written from the snapshot being shipped, not from the live
store, so a build that commits mid-export cannot produce a manifest describing
a different corpus from the one inside it.

An import trusts none of it until every check passes, in this order:

1. **the container** — gzip, then ustar with regular files only. Links,
   directories, pax headers and devices are refused by name, and decompression
   is capped so a gzip bomb cannot exhaust memory.
2. **the names** — exactly the three above. An absolute path, `..` or a nested
   path is reported as what it is, a crafted archive, rather than as an unknown
   entry. Entry names are never used as paths in any case.
3. **the checksums** — every file's size and SHA-256 against the manifest.
4. **the schema** — a layout this build reads. A newer archive format is an
   incompatibility (exit 4), not corruption.
5. **the config** — valid, naming the same corpus, and chunking text the way the
   index was chunked, since otherwise the corpus could never be searched.
6. **the database** — opened from a private copy, read-only, with
   `trusted_schema` off. It must pass SQLite's `quick_check`, define no triggers
   or views, and match the manifest's identity and counts field by field.

Only then is anything written, and the install is one rename from a staging
directory: a refusal or a crash leaves the workspace exactly as it was.

**The checksums prove an archive arrived intact, not who made it.** They are
written by whoever made the archive, so they catch corruption and tampering in
transit, not a malicious author. Import archives from people you would take the
documents themselves from; signing is on the roadmap.

**The embedding model is not checked at import.** It is checked when the corpus
is first searched, against whatever this machine is configured with — the only
comparison that means anything.

**An imported corpus keeps its source list.** Search and `read` work without
the sources, since documents are stored in full. `update` fails with "source
path does not exist" rather than deleting anything, until the sources exist
here.

## `evaluation_report`

Produced by `graphdog eval <dataset.json>`. CLI only: measuring retrieval is a
maintainer's job, not something an agent should be able to trigger mid-task.

```json
{
  "kind": "evaluation_report",
  "dataset": "graphdog-docs",
  "corpus": "graphdog",
  "embedding_id": "hash-v1:d256",
  "k": 10,
  "strategy": { "fusion": "rrf", "min_score": 0.12, "top_k": 10 },
  "summary": {
    "queries": 12, "measured": 12,
    "recall_at_k": 1.0, "precision_at_k": 0.141667,
    "mrr": 0.590278, "ndcg_at_k": 0.669719,
    "evidence_accuracy": 0.705882, "evidence_checked": 17,
    "zero_result_queries": 0, "missed_queries": 0, "failed_queries": 0,
    "latency": { "mean_ms": 3.7, "p50_ms": 2, "p95_ms": 15, "max_ms": 15 }
  },
  "queries": [
    { "id": "why-rrf", "query": "why is reciprocal rank fusion used…",
      "note": null,
      "metrics": { "recall_at_k": 1.0, "precision_at_k": 0.2,
                   "reciprocal_rank": 1.0, "ndcg_at_k": 1.0,
                   "evidence_checked": 2, "evidence_correct": 2,
                   "evidence_accuracy": 1.0, "retrieved": 4, "relevant": 2 },
      "elapsed_ms": 2,
      "retrieved_refs": ["docs/design/decisions.md", "docs/design/architecture.md"],
      "missing_refs": [],
      "error": null }
  ],
  "comparison": [
    { "metric": "recall", "baseline": 0.708333, "current": 1.0, "delta": 0.291667 }
  ],
  "status": "ok",
  "gate_failures": [],
  "warnings": []
}
```

**`null` means unmeasurable, never zero.** A query with no judgments still runs
and still costs latency, but contributes to no metric. Averaging a fabricated
zero would move the headline number for no reason, so the aggregate is the mean
of what could actually be measured, and `measured` says how many that was.

**`evidence_accuracy` is conditional on retrieval.** Only spans of documents
that were actually found are checked — a missed document is a recall failure and
is counted as one there. The consequence is that this ratio is *not* monotone
with retrieval quality: improving recall brings new spans under test and can
lower it while raising `evidence_correct`. Read it beside `evidence_checked`,
and gate on recall or MRR.

**`comparison` is null unless `--baseline` was given.** `status` is `failed`
when any gate was breached, and `gate_failures` says which and why. The run
itself still completed; the process exits **8**, so CI can tell "search got
worse" apart from "the command was wrong".

A query that throws is recorded with an `error` and scored as a miss rather than
aborting the run — a dataset of forty queries should not lose its report because
one of them hit a bad extractor.

### The dataset format

Plain JSON, written and reviewed by hand, meant to live beside the documents it
judges:

```jsonc
{
  "version": 1,
  "name": "auth-docs",
  "corpus": "docs",
  "queries": [
    {
      "id": "jwks-rotation",
      "query": "how are signing keys rotated",
      "note": "paraphrase: the docs never say 'rotate'",
      "relevant": [
        { "ref": "docs/keys.md", "grade": 3, "lines": "12-28" },
        "docs/token.md"
      ]
    }
  ]
}
```

`grade` is 0–3 and defaults to 1, so a binary dataset needs no grades at all. A
bare string is shorthand for `{ "ref": …, "grade": 1 }`. `lines` accepts
`"12-28"`, `"12"`, `12` or `[12, 28]`, and is matched by **overlap**: chunk
boundaries move when chunking parameters change, and demanding an exact match
would measure the chunker rather than the retrieval.

Validation is strict and names the exact entry (`queries[1].relevant[0].ref`). A
dataset is the yardstick every later measurement is compared against, so a
typo'd ref that silently scored as a miss would make the whole number wrong in a
direction nobody would question — which is also why a judged ref the corpus does
not contain raises `eval_unknown_ref` rather than passing quietly.

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
| `archive_invalid` | 1 | An archive failed verification: corrupt, inconsistent or crafted |
| `extraction_failed` | — | Per-file; collected into `failures` |
| `error` | 1 | Unexpected |

Two exit codes report an outcome rather than an error, and have no error
envelope: **7** when a query ran and nothing cleared the evidence threshold, and
**8** when an evaluation ran and breached a gate.

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
| `corpus_skipped` | A corpus could not be opened during a cross-corpus search |
| `mixed_embeddings` | Corpora with different embedding models were searched together |
| `eval_query_failed` | An evaluation query threw; it is scored as a miss |
| `eval_unknown_ref` | The dataset judges a ref the corpus does not contain |
| `corpus_shadowed` | An imported corpus shares its name with one that is found first |

## Stability

- Additions are always allowed. Field removals and semantic changes bump
  `contract_version`.
- Error codes, warning codes and exit codes are append-only.
- `kind` values are stable.
- Numbers round to six decimal places.

An unknown warning code or an extra field should be ignored, not rejected.
