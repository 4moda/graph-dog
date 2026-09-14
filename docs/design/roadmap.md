# Roadmap

What exists, what does not, and what was deliberately deferred.

## Built

- Domain: tokenization, chunking with exact locations, BM25, fusion, graph
  construction and expansion, link resolution, snippet selection
- Use cases: build, incremental update, search, explore, read, describe
- Storage: single-file SQLite corpus with atomic builds
- Sources: local folders, git working trees (revision-aware, `.gitignore`-honest)
- Extraction: Markdown, plain text, source code; PDF and DOCX behind optional deps
- Embedding: built-in lexical hashing; local ONNX semantic models opt-in
- Reranking: cross-encoder, opt-in, degrades to a warning when unavailable
- CLI: `init`, `add`, `build`, `update`, `search`, `explore`, `read`, `status`, `list`
- MCP: `search`, `explore`, `read`, `status`, `list_corpora`, `build_corpus` (write-gated)
- Compatibility gate, freshness reporting, auditable exclusions and failures
- 860+ tests, every source file with a colocated spec

## Next

### Portable corpus artifacts

Designed, not built. `export` and `import` producing a single `.gdog` archive:

```
manifest.json      schema version · embedding identity · chunking fingerprint
                   source manifest · per-file checksums · build timestamp
corpus.sqlite3     the index
```

Import must verify checksums, reject path traversal, and refuse an incompatible
schema rather than importing it. The compatibility gate already exists; this is
the transport around it.

A corpus is already a single file that can be copied, which covers the common
case — the archive adds verification and a manifest for distribution.

### Evaluation harness

The handoff named the metrics: Recall@K, MRR, nDCG, evidence-line accuracy,
indexing throughput, query latency. What is missing is a fixed corpus and query
set to measure against, and a regression gate in CI.

This matters more than any individual ranking tweak: without it, "the lexical
default is good enough" is an assertion rather than a measurement — and it is
the open question most likely to change the defaults.

### Multi-corpus search

`list_corpora` exists; searching across several at once does not. It needs a
decision on how to fuse scores across corpora built with different embedding
models — which, given the compatibility gate, probably means refusing to fuse
them and returning grouped results instead.

## Later

- **Registry distribution** — OCI artifacts, GitHub Packages, GitLab Generic
  Package Registry, in that order of preference. Wants signature verification.
- **More sources** — Confluence, GitLab wikis and issues, SharePoint, and a
  connector SDK so adapters live outside this repository.
- **Morphological Japanese tokenization** — `kuromoji` behind the existing
  tokenizer interface, as an opt-in alternative to bigrams. Worth measuring
  before adopting: bigrams over-generate slightly but never miss domain
  vocabulary a dictionary has not seen.
- **ANN vector backend** — behind the existing `VectorIndex` port, if corpus
  sizes outgrow exhaustive scan.
- **Query expansion and optional LLM summarization** — as plugins. The
  no-LLM-required guarantee stays.
- **Agent skill packaging** — distributing GraphDog as a ready-made skill for
  agent runtimes.

## Not planned

- **A chat UI.** This is search infrastructure. Something else can build a UI on
  the contract.
- **A required LLM.** Building and searching stays fully local and offline.
- **A server mode.** A corpus is a file; the MCP server is a process, not a
  service to operate.
