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
- Multi-corpus search: `--corpus` repeated or `--all`, merged by rank across corpora
- Evaluation harness: judged datasets, IR metrics, baselines and a CI regression gate
- Portable archives: `export` and `import` of a verified `.gdog` file
- CLI: `init`, `add`, `build`, `update`, `search`, `explore`, `read`, `status`, `list`, `eval`,
  `export`, `import`
- MCP: `search`, `explore`, `read`, `status`, `list_corpora`, `build_corpus` (write-gated)
- Compatibility gate, freshness reporting, auditable exclusions and failures
- 1290+ tests, every source file with a colocated spec

## Next

### Ranking work the harness has already identified

The evaluation harness is built, and the first thing it did was find a defect:
graph expansion was giving every chunk of a reached document the same score, so
one graph claim became forty tied candidates that RRF ordered by chunk id.
Fixing it — one representative chunk per document — moved every metric on the
built-in dataset at once:

| | before | after |
|---|---|---|
| recall@10 | 0.762 | **1.000** |
| precision@10 | 0.114 | **0.150** |
| MRR | 0.536 | **0.577** |
| nDCG@10 | 0.536 | **0.632** |
| queries that missed entirely | 2 | **0** |

What the same dataset still shows, unfixed:

- **MRR is 0.58 with the lexical default.** The right document is reliably found
  and reliably not first — including for `read_ref line range`, which names a
  field verbatim. Exact-term queries should not need four results.
- **Precision@10 is 0.15.** The corpus has four documents, so this is partly an
  artifact of dividing by k — but it is also fusion returning a full page of
  results when two would do.
- **No semantic measurement.** Every number here is the hashing embedder. The
  case for making a semantic model the default cannot be made until the same
  dataset has been run against one, on a corpus large enough for the difference
  to show.

The dataset is twelve queries over GraphDog's own docs. It is a tripwire, not
evidence that retrieval is good; a real judgment of the defaults needs a corpus
somebody actually works in.

## Later

- **Registry distribution** — OCI artifacts, GitHub Packages, GitLab Generic
  Package Registry, in that order of preference. Wants signature verification: `.gdog` archives already carry checksums, which
  prove an archive is intact but not who made it.
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
